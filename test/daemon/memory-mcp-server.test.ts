import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_INJECTED_EXECUTION_BLOCK,
  MCP_INJECTED_SCHEMA_DIALECT,
  MCP_TOOL_SURFACE_AUTHORED_BUDGET_BYTES,
  MCP_TOOL_SURFACE_BOOTSTRAP_BUDGET_BYTES,
  MCP_TOOL_SURFACE_RAW_BUDGET_BYTES,
  mcpToolSurfaceBytes,
  projectAuthoredMcpToolSurface,
} from '../../shared/mcp-tool-surface-budget.js';
import {
  MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE,
  MCP_TOOL_DISCOVERY_DESCRIPTION,
  MCP_TOOL_DISCOVERY_NAME,
  MCP_TOOL_GROUPS,
} from '../../shared/mcp-tool-discovery.js';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MEMORY_MCP_ENV_KEYS, buildMemoryMcpServerEnv } from '../../shared/memory-mcp-env.js';
import { MEMORY_MCP_TOOL_NAME_LIST, MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { ALIAS_MCP_TOOLS } from '../../shared/alias-types.js';
import { MESSAGE_PIN_MCP_TOOLS } from '../../shared/message-pins.js';
import { CAPABILITY_MCP_TOOL_NAMES } from '../../shared/capability-management.js';
import { SUPERVISION_MCP_REGISTERED_TOOLS } from '../../shared/supervision-mcp-tools.js';
import { AGENT_DELEGATION_REPLY_ERRORS } from '../../shared/agent-delegation.js';
import {
  createMemoryMcpServerFromEnv,
  createMemoryMcpServer,
  mergeDefaultToolDeps,
  postHookSend,
} from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

// Hoisted mock: prove the production run-authoritative limit resolver is wired
// into the composed deps WITHOUT a manual inject. A tight cap=1 (distinct from
// the cap=3 default) lets the assertion confirm the daemon resolver — not a
// default — is what backs the merged `resolveExecutionCloneLimits`.
vi.mock('../../src/daemon/execution-clone-limits-resolver.js', () => ({
  resolveExecutionCloneLimitsForParentRun: vi.fn(() => ({
    enabled: false,
    maxParallelClones: 1,
    maxQueuedClones: 1,
    cloneHardTimeoutMs: 1000,
    cloneRetentionMs: 1000,
  })),
}));

const namespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };

async function writeSessionStore(home: string, options: { includeLatePeer?: boolean } = {}): Promise<void> {
  const imcodesDir = join(home, '.imcodes');
  await mkdir(imcodesDir, { recursive: true });
  const now = Date.now();
  await writeFile(join(imcodesDir, 'sessions.json'), JSON.stringify({
    sessions: {
      deck_proj_brain: {
        name: 'deck_proj_brain',
        projectName: 'proj',
        role: 'brain',
        agentType: 'codex-sdk',
        projectDir: join(home, 'proj'),
        state: 'idle',
        restarts: 0,
        restartTimestamps: [],
        createdAt: now,
        updatedAt: now,
        runtimeType: 'transport',
      },
      deck_sub_worker: {
        name: 'deck_sub_worker',
        projectName: 'proj',
        role: 'w1',
        agentType: 'codex-sdk',
        projectDir: join(home, 'proj'),
        state: 'idle',
        restarts: 0,
        restartTimestamps: [],
        createdAt: now,
        updatedAt: now,
        parentSession: 'deck_proj_brain',
        runtimeType: 'transport',
        label: 'Worker',
      },
      deck_sub_peer: {
        name: 'deck_sub_peer',
        projectName: 'proj',
        role: 'w1',
        agentType: 'claude-code-sdk',
        projectDir: join(home, 'proj'),
        state: 'idle',
        activeModel: 'claude-opus-4-8',
        requestedModel: 'opus',
        modelDisplay: 'claude-opus-4-8',
        restarts: 0,
        restartTimestamps: [],
        createdAt: now,
        updatedAt: now,
        parentSession: 'deck_proj_brain',
        runtimeType: 'transport',
        label: 'Peer',
      },
      ...(options.includeLatePeer ? {
        deck_sub_late: {
          name: 'deck_sub_late',
          projectName: 'proj',
          role: 'w1',
          agentType: 'gemini-sdk',
          projectDir: join(home, 'proj'),
          state: 'idle',
          restarts: 0,
          restartTimestamps: [],
          createdAt: now,
          updatedAt: now,
          parentSession: 'deck_proj_brain',
          runtimeType: 'transport',
          label: 'Late',
        },
      } : {}),
    },
  }), 'utf8');
}

function mcpEnv(home: string): Record<string, string | undefined> {
  return buildMemoryMcpServerEnv({
    [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
    [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify(namespace),
    [MEMORY_MCP_ENV_KEYS.SESSION_NAME]: 'deck_sub_worker',
    [MEMORY_MCP_ENV_KEYS.PROJECT_NAME]: 'proj',
    [MEMORY_MCP_ENV_KEYS.PROJECT_ROOT]: join(home, 'proj'),
    [MEMORY_MCP_ENV_KEYS.SERVER_ID]: 'srv-1',
  }, {
    PATH: process.env.PATH,
    HOME: home,
  });
}

async function callLazyTool(client: Client, name: string, args: Record<string, unknown>) {
  const activation = await client.callTool({
    name: MCP_TOOL_DISCOVERY_NAME,
    arguments: { query: name },
  });
  expect(activation.isError).not.toBe(true);
  return client.callTool({ name, arguments: args });
}

describe('memory MCP stdio server', () => {
  it('starts with local defaults when env identity is absent and rejects invalid namespace', async () => {
    expect(createMemoryMcpServerFromEnv({ env: {} }).isConnected()).toBe(false);
    expect(() => createMemoryMcpServerFromEnv({
      env: {
        [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
        [MEMORY_MCP_ENV_KEYS.NAMESPACE]: '{not-json',
      },
    })).toThrow('must be valid JSON');
  });

  it('creates a valid server without requiring a local bound-user check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-mcp-bound-'));
    process.env.IMCODES_SERVER_CONFIG_PATH = join(dir, 'server.json');
    await writeFile(process.env.IMCODES_SERVER_CONFIG_PATH, JSON.stringify({ serverId: 'srv-local' }), 'utf8');
    try {
      const server = createMemoryMcpServerFromEnv({
        env: {
          [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
          [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify(namespace),
        },
      });
      expect(server.isConnected()).toBe(false);
    } finally {
      delete process.env.IMCODES_SERVER_CONFIG_PATH;
    }
  });

  it('lists the registered shared tools over stdio and does not leak secret env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-mcp-stdio-'));
    const serverConfigPath = join(dir, 'server.json');
    await writeFile(serverConfigPath, JSON.stringify({ serverId: 'srv-local' }), 'utf8');

    const env = buildMemoryMcpServerEnv({
      [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
      [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify(namespace),
      [MEMORY_MCP_ENV_KEYS.SESSION_NAME]: 'deck_proj_brain',
      [MEMORY_MCP_ENV_KEYS.PROJECT_NAME]: 'proj',
      [MEMORY_MCP_ENV_KEYS.PROJECT_ROOT]: dir,
      [MEMORY_MCP_ENV_KEYS.SERVER_ID]: 'srv-1',
    }, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      IMCODES_SERVER_TOKEN: 'server-secret',
      OPENAI_API_KEY: 'api-secret',
    });
    env.IMCODES_SERVER_CONFIG_PATH = serverConfigPath;

    const client = new Client({ name: 'memory-mcp-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env,
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const bootstrap = await client.listTools();
      // Core tools must be usable WITHOUT a discovery round-trip; only the long
      // tail is hidden. Asserting the exact set both ways keeps this honest: a
      // shrunken allowlist and a leaked non-core tool both fail here.
      const bootstrapNames = bootstrap.tools.map((tool) => tool.name).sort();
      expect(bootstrapNames).toEqual([MCP_TOOL_DISCOVERY_NAME, ...MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE].sort());
      expect(bootstrap.tools).toHaveLength(20);
      expect(new Set(bootstrapNames).size).toBe(bootstrapNames.length);
      expect(bootstrapNames).not.toContain(MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE);
      expect(bootstrapNames).not.toContain(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES);
      expect(bootstrapNames).not.toContain(MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL);
      expect(bootstrapNames).not.toContain(MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES);
      expect(bootstrapNames).not.toContain(MEMORY_MCP_TOOL_NAMES.CRON_LIST);
      expect(bootstrapNames).not.toContain(ALIAS_MCP_TOOLS.LIST);
      expect(bootstrapNames).toEqual(expect.arrayContaining([
        MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
        MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF,
        MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
      ]));
      expect(mcpToolSurfaceBytes(bootstrap.tools)).toBeLessThanOrEqual(MCP_TOOL_SURFACE_BOOTSTRAP_BUDGET_BYTES);
      expect(client.getInstructions()).toBeUndefined();
      const bootstrapDescriptions = bootstrap.tools.map((tool) => tool.description ?? '').join('\n');
      expect(bootstrapDescriptions.split(MCP_TOOL_DISCOVERY_DESCRIPTION)).toHaveLength(2);
      expect(bootstrapDescriptions.match(/mcp_tool_search/g)).toHaveLength(1);

      const activation = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: '*' },
      });
      expect(activation.isError).not.toBe(true);
      const listed = await client.listTools();
      const listedNames = listed.tools.map((tool) => tool.name);
      const expectedFullNames = new Set([
        MCP_TOOL_DISCOVERY_NAME,
        ...MEMORY_MCP_TOOL_NAME_LIST,
        ...Object.values(ALIAS_MCP_TOOLS),
        ...Object.values(MESSAGE_PIN_MCP_TOOLS),
        ...SUPERVISION_MCP_REGISTERED_TOOLS,
        ...CAPABILITY_MCP_TOOL_NAMES,
      ]);
      expect(new Set(listedNames)).toEqual(expectedFullNames);
      expect(activation.structuredContent).toMatchObject({
        activated: expect.arrayContaining([...expectedFullNames].filter((name) => name !== MCP_TOOL_DISCOVERY_NAME)),
      });
      expect((activation.structuredContent as { activated: unknown[] }).activated)
        .toHaveLength(expectedFullNames.size - 1);
      expect(listedNames).toContain(MCP_TOOL_DISCOVERY_NAME);
      // Memory tools plus the full alias CRUD tool set share the same server surface.
      expect(listedNames).toEqual(expect.arrayContaining([...MEMORY_MCP_TOOL_NAME_LIST]));
      expect(listedNames).toEqual(expect.arrayContaining([
        ALIAS_MCP_TOOLS.RESOLVE,
        ALIAS_MCP_TOOLS.LIST,
        ALIAS_MCP_TOOLS.SAVE,
        ALIAS_MCP_TOOLS.DELETE,
      ]));
      for (const tool of listed.tools) {
        expect(tool.description).toBeTruthy();
        // The protocol name already identifies the tool; repeating it as title
        // costs prompt tokens without adding model-visible semantics.
        expect(tool.title).toBeUndefined();
      }
      // Provider tokenizers differ, so enforce the stable serialized payload
      // size here. This keeps the fixed tools/list prompt bounded while
      // allowing the complete message-pin CRUD/search schemas.
      // Explicit-path machine file-transfer tools plus the strict structured
      // peer-audit reply envelope, recurring-cron completion policy, and the
      // four unified capability-management contracts add safety contracts to
      // the fixed surface. Keep explicit headroom bounded rather than silently
      // dropping those schemas from managed providers.
      // DUAL ACCOUNTING. See shared/mcp-tool-surface-budget.ts.
      //
      // Raw is the literal wire payload. Authored is raw minus the only two
      // shapes the SDK/JSON-Schema layer injects for us and that registerTool
      // gives no supported way to suppress. Both are bounded, so neither
      // authored growth nor protocol growth can hide behind the other.
      const raw = mcpToolSurfaceBytes(listed.tools);
      const { authored, removed } = projectAuthoredMcpToolSurface(listed.tools);
      const authoredBytes = mcpToolSurfaceBytes(authored);

      // Every exclusion must be one of the two KNOWN injected forms. This is
      // what stops the projection from becoming a way to make the number go
      // down by quietly dropping real authored content.
      expect(removed.length).toBeGreaterThan(0);
      for (const entry of removed) {
        expect(['$schema', 'execution']).toContain(entry.key);
        if (entry.key === '$schema') expect(entry.value).toBe(MCP_INJECTED_SCHEMA_DIALECT);
        else expect(entry.value).toEqual(MCP_INJECTED_EXECUTION_BLOCK);
      }
      // Aggregate backstop: the projection may only remove what those two
      // shapes actually cost. A projection that stripped anything else would
      // push authoredBytes below this floor.
      const injectedBytes = raw - authoredBytes;
      expect(injectedBytes).toBe(removed.reduce(
        (sum, entry) => sum + JSON.stringify({ [entry.key]: entry.value }).length - 1,
        0,
      ));

      expect(raw).toBeLessThanOrEqual(MCP_TOOL_SURFACE_RAW_BUDGET_BYTES);
      expect(authoredBytes).toBeLessThanOrEqual(MCP_TOOL_SURFACE_AUTHORED_BUDGET_BYTES);
      expect(JSON.stringify(listed)).not.toContain('server-secret');
      expect(JSON.stringify(listed)).not.toContain('api-secret');
    } finally {
      await client.close();
    }

    expect(readFileSync(serverConfigPath, 'utf8')).not.toContain('userId');
  });

  it('lists tools over stdio without identity env', async () => {
    const client = new Client({ name: 'memory-mcp-local-default-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
      },
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const listedNames = listed.tools.map((tool) => tool.name);
      expect(listedNames).toEqual(expect.arrayContaining([MCP_TOOL_DISCOVERY_NAME, ...MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE]));
    } finally {
      await client.close();
    }
  });

  it('activates only matching tools and replaces the previous lazy result set', async () => {
    const client = new Client({ name: 'memory-mcp-lazy-tools-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([MCP_TOOL_DISCOVERY_NAME, ...MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE]));

      const sendSearch = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE },
      });
      expect(sendSearch.structuredContent).toMatchObject({ activated: [MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE] });
      // Replacement applies to the DISCOVERED tail only: core tools are never
      // retired by a later search, or an agent would lose delegation mid-workflow.
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        MCP_TOOL_DISCOVERY_NAME,
        ...MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE,
      ].sort());

      // Replacement is observable between two lazy tools: activate one, then
      // search another and require the first to be retired.
      await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL },
      });
      const cronSearch = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES },
      });
      expect(cronSearch.structuredContent).toMatchObject({
        activated: expect.arrayContaining([MEMORY_MCP_TOOL_NAMES.LIST_MACHINES]),
      });
      const cronNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(cronNames).toContain(MCP_TOOL_DISCOVERY_NAME);
      expect(cronNames).toContain(MEMORY_MCP_TOOL_NAMES.LIST_MACHINES);
      // send_message is core, so it survives an unrelated search.
      expect(cronNames).toContain(MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE);
      // ...while the previously discovered lazy tool is retired as designed.
      expect(cronNames).not.toContain(MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL);
      // Cached self-wakeup loops survive every replacement without searching.
      expect(cronNames).toEqual(expect.arrayContaining([
        MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
        MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF,
        MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
      ]));
    } finally {
      await client.close();
    }
  });

  it('previews and atomically activates a named group for multiple authoritative calls', async () => {
    const client = new Client({ name: 'memory-mcp-group-activation-test', version: '0.1.0' }, {});
    const server = createMemoryMcpServer({
      transport: 'in_process',
      userId: 'user-1',
      namespace,
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
      projectRoot: '/tmp/proj',
    }, {}, {
      listPins: vi.fn(async () => ({ status: 'ok' as const, pins: [] })),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const publish = vi.spyOn(server, 'sendToolListChanged');

      const preview = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:aliases-pins', activate: false },
      });
      expect(preview.structuredContent).toMatchObject({
        status: 'ok',
        activated: [],
        activatedGroups: [],
        groups: [expect.objectContaining({
          id: 'aliases-pins', name: 'aliases-pins', toolCount: 8, active: false,
          tools: expect.arrayContaining([ALIAS_MCP_TOOLS.LIST, MESSAGE_PIN_MCP_TOOLS.LIST]),
        })],
      });
      expect(JSON.stringify(preview.structuredContent)).not.toMatch(/inputSchema|properties|additionalProperties/);
      expect(publish).not.toHaveBeenCalled();

      const activation = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:aliases-pins' },
      });
      expect(activation.structuredContent).toMatchObject({
        status: 'ok',
        activatedGroups: ['aliases-pins'],
        activated: expect.arrayContaining([
          ALIAS_MCP_TOOLS.LIST, ALIAS_MCP_TOOLS.RESOLVE,
          MESSAGE_PIN_MCP_TOOLS.LIST, MESSAGE_PIN_MCP_TOOLS.SAVE,
        ]),
        groups: [expect.objectContaining({ id: 'aliases-pins', toolCount: 8, active: true })],
      });
      expect(publish).toHaveBeenCalledTimes(1);

      await expect(client.callTool({ name: ALIAS_MCP_TOOLS.LIST, arguments: {} })).resolves.toMatchObject({
        structuredContent: expect.objectContaining({ status: 'ok' }),
      });
      await expect(client.callTool({ name: MESSAGE_PIN_MCP_TOOLS.LIST, arguments: {} })).resolves.toMatchObject({
        structuredContent: expect.objectContaining({ status: 'ok', pins: [] }),
      });

      const replacement = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:scheduling' },
      });
      expect(replacement.structuredContent).toMatchObject({
        activatedGroups: ['scheduling'],
        groups: [expect.objectContaining({ id: 'scheduling', toolCount: 7, active: true })],
      });
      expect(publish).toHaveBeenCalledTimes(2);
      const replacementNames = (await client.listTools()).tools.map((tool) => tool.name);
      expect(replacementNames).toContain(MEMORY_MCP_TOOL_NAMES.CRON_LIST);
      expect(replacementNames).toEqual(expect.arrayContaining([
        MEMORY_MCP_TOOL_NAMES.CRON_CREATE_SELF,
        MEMORY_MCP_TOOL_NAMES.CRON_UPDATE_SELF,
        MEMORY_MCP_TOOL_NAMES.CRON_CANCEL_SELF,
      ]));
      expect(replacementNames).not.toContain(ALIAS_MCP_TOOLS.LIST);
      expect((await client.callTool({ name: ALIAS_MCP_TOOLS.LIST, arguments: {} })).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('matches task phrases to groups and fails closed for unknown or unauthorized groups', async () => {
    const client = new Client({ name: 'memory-mcp-group-authority-test', version: '0.1.0' }, {});
    const server = createMemoryMcpServer({
      transport: 'in_process',
      userId: 'user-1',
      namespace,
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
      projectRoot: '/tmp/proj',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      expect(MCP_TOOL_GROUPS.every((group) => group.summary.length <= 180)).toBe(true);

      const phrase = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'scheduled work', activate: false },
      });
      expect(phrase.structuredContent).toMatchObject({
        groups: [expect.objectContaining({ id: 'scheduling', toolCount: 7 })],
      });

      const unknown = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:not-real' },
      });
      expect(unknown).toMatchObject({ isError: true, structuredContent: {
        status: 'error', reason: 'validation_failed',
      } });

      // The capability group exists, but an unbound node registers none of its
      // members. Group discovery must neither disclose nor manufacture them.
      const unauthorized = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'group:capability-management' },
      });
      expect(unauthorized.structuredContent).toMatchObject({
        status: 'ok', activated: [], activatedGroups: ['capability-management'],
        groups: [expect.objectContaining({
          id: 'capability-management', toolCount: 0, tools: [], active: false,
        })],
      });
      expect((await client.callTool({ name: 'capability_install', arguments: {} })).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('atomically activates a hidden tool, preserves handler scope, and rejects unknown or unavailable tools', async () => {
    const client = new Client({ name: 'memory-mcp-activation-authority-test', version: '0.1.0' }, {});
    const server = createMemoryMcpServer({
      transport: 'in_process',
      userId: 'user-1',
      namespace,
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
      projectRoot: '/tmp/proj',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const activation = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: ALIAS_MCP_TOOLS.LIST },
      });
      expect(activation.structuredContent).toMatchObject({
        status: 'ok',
        activated: [ALIAS_MCP_TOOLS.LIST],
        matches: [expect.objectContaining({ name: ALIAS_MCP_TOOLS.LIST, active: true })],
      });
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(ALIAS_MCP_TOOLS.LIST);
      await expect(client.callTool({ name: ALIAS_MCP_TOOLS.LIST, arguments: {} })).resolves.toMatchObject({
        isError: false,
        structuredContent: expect.objectContaining({ status: 'ok' }),
      });

      const unknown = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'definitely_not_an_imcodes_tool' },
      });
      expect(unknown.structuredContent).toMatchObject({ status: 'ok', matches: [], activated: [] });
      const unknownCall = await client.callTool({ name: 'definitely_not_an_imcodes_tool', arguments: {} });
      expect(unknownCall.isError).toBe(true);

      // Capability tools are not even registered without an authorized node
      // service. Discovery cannot manufacture authority or a callable schema.
      const unauthorized = await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: 'capability_install' },
      });
      expect(unauthorized.structuredContent).toMatchObject({ status: 'ok', matches: [], activated: [] });
      const unauthorizedCall = await client.callTool({ name: 'capability_install', arguments: {} });
      expect(unauthorizedCall.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  // Must observe a NON-core tool: core tools are already enabled at bootstrap, so
  // activating one is a no-op and emits no tools/list_changed at all.
  // Blind spot in the original lazy-tools change: nothing covered what happens
  // when a client calls a tool WITHOUT searching first. That is the exact path a
  // cached tool list or a hard-coded call takes, so both outcomes are pinned.
  it('serves core tools without discovery and rejects a hidden one', async () => {
    const client = new Client({ name: 'memory-mcp-no-discovery-test', version: '0.1.0' }, {});
    const server = createMemoryMcpServer({
      transport: 'in_process',
      userId: 'user-1',
      namespace,
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
      projectRoot: '/tmp/proj',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      // Core: callable with no discovery round-trip at all.
      const core = await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
        arguments: {},
      });
      expect(core.isError).not.toBe(true);
      // Non-core: still hidden, and the failure is explicit rather than silent.
      const hidden = await client.callTool({
        name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
        arguments: {},
      });
      // Surfaces as an error RESULT, not a thrown rejection: a caller that
      // ignores isError would read this as success, which is why it is pinned.
      expect(hidden.isError).toBe(true);
      expect(JSON.stringify(hidden.content)).toMatch(/disabled/i);
    } finally {
      await client.close();
    }
  });

  it('publishes a refreshed tool list when discovery changes the active set', async () => {
    let resolveChanged: ((names: string[]) => void) | undefined;
    const changed = new Promise<string[]>((resolve) => { resolveChanged = resolve; });
    const client = new Client({ name: 'memory-mcp-list-changed-test', version: '0.1.0' }, {
      listChanged: {
        tools: {
          debounceMs: 0,
          onChanged: (error, tools) => {
            if (!error && tools?.some((tool) => tool.name === MEMORY_MCP_TOOL_NAMES.LIST_MACHINES)) {
              resolveChanged?.(tools.map((tool) => tool.name));
            }
          },
        },
      },
    });
    const server = createMemoryMcpServer({
      transport: 'in_process',
      userId: 'user-1',
      namespace,
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
      projectRoot: '/tmp/proj',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      await client.callTool({
        name: MCP_TOOL_DISCOVERY_NAME,
        arguments: { query: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES },
      });
      await expect(changed).resolves.toEqual(expect.arrayContaining([
        MCP_TOOL_DISCOVERY_NAME,
        MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
      ]));
    } finally {
      await client.close();
    }
  });

  it('loads persisted sessions before serving scoped send targets over stdio', async () => {
    const home = await mkdtemp(join(tmpdir(), 'imcodes-mcp-session-store-'));
    await writeSessionStore(home);

    const client = new Client({ name: 'memory-mcp-send-target-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env: mcpEnv(home),
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const result = await callLazyTool(client, 'send_list_targets', {});
      expect(result.structuredContent).toMatchObject({
        status: 'ok',
        items: [
          expect.objectContaining({ target: 'deck_proj_brain' }),
          expect.objectContaining({
            target: 'deck_sub_peer',
            label: 'Peer',
            model: 'claude-opus-4-8',
            activeModel: 'claude-opus-4-8',
            requestedModel: 'opus',
          }),
        ],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain('deck_sub_worker');

      await writeSessionStore(home, { includeLatePeer: true });
      const refreshed = await callLazyTool(client, 'send_list_targets', { query: 'Late' });
      expect(refreshed.structuredContent).toMatchObject({
        status: 'ok',
        items: [expect.objectContaining({ target: 'deck_sub_late', label: 'Late' })],
      });
    } finally {
      await client.close();
    }
  });

  it('dispatches send_message through the daemon hook server from stdio MCP', async () => {
    const home = await mkdtemp(join(tmpdir(), 'imcodes-mcp-hook-send-'));
    await writeSessionStore(home);
    const hookBodies: Array<Record<string, unknown>> = [];
    const hookServer = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/send') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        hookBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body.deliveryMode === 'queue'
          ? { ok: true, queued: true, target: body.to }
          : { ok: true, delivered: true, target: body.to }));
      });
    });

    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const address = hookServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP hook server address');
    await writeFile(join(home, '.imcodes', 'hook-port'), String(address.port), 'utf8');

    const client = new Client({ name: 'memory-mcp-hook-send-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env: mcpEnv(home),
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const result = await callLazyTool(client, 'send_message', {
          target: 'deck_sub_peer',
          message: 'hello from stdio mcp',
      });

      expect(result.structuredContent).toMatchObject({
        status: 'accepted',
        deliveries: [expect.objectContaining({ target: 'deck_sub_peer', status: 'delivered' })],
      });
      expect(hookBodies).toEqual([{
        from: 'deck_sub_worker',
        to: 'deck_sub_peer',
        message: 'hello from stdio mcp',
        depth: 0,
        deliveryMode: 'append',
      }]);

      const queuedResult = await callLazyTool(client, 'send_message', {
          target: 'deck_sub_peer',
          message: 'queue this from stdio mcp',
          deliveryMode: 'queue',
      });
      expect(queuedResult.structuredContent).toMatchObject({
        status: 'accepted',
        deliveries: [expect.objectContaining({ target: 'deck_sub_peer', status: 'queued' })],
      });
      expect(hookBodies.at(-1)).toEqual({
        from: 'deck_sub_worker',
        to: 'deck_sub_peer',
        message: 'queue this from stdio mcp',
        depth: 0,
        deliveryMode: 'queue',
      });

      await writeSessionStore(home, { includeLatePeer: true });
      const refreshedSend = await callLazyTool(client, 'send_message', {
          target: 'deck_sub_late',
          message: 'hello late peer',
      });
      expect(refreshedSend.structuredContent).toMatchObject({
        status: 'accepted',
        deliveries: [expect.objectContaining({ target: 'deck_sub_late', status: 'delivered' })],
      });
      expect(hookBodies.at(-1)).toMatchObject({
        from: 'deck_sub_worker',
        to: 'deck_sub_late',
        message: 'hello late peer',
        depth: 0,
      });
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => hookServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('submits peer_audit_reply to dedicated ingress with the runtime-bound sender header', async () => {
    const home = await mkdtemp(join(tmpdir(), 'imcodes-mcp-audit-reply-'));
    await writeSessionStore(home);
    const received: Array<{ body: Record<string, unknown>; sender?: string }> = [];
    const hookServer = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/audit-reply') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received.push({
          body: JSON.parse(raw) as Record<string, unknown>,
          sender: typeof req.headers['x-imcodes-session'] === 'string' ? req.headers['x-imcodes-session'] : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const address = hookServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP hook server address');
    await writeFile(join(home, '.imcodes', 'hook-port'), String(address.port), 'utf8');
    const client = new Client({ name: 'memory-mcp-audit-reply-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env: mcpEnv(home),
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const result = await callLazyTool(client, 'peer_audit_reply', {
          attemptId: 'attempt_12345678',
          replyCapability: 'A'.repeat(32),
          verdict: 'PASS',
          findings: 'Focused checks passed.',
          validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '12 passed' }],
      });
      expect(result.structuredContent).toEqual({ status: 'ok', accepted: true });
      expect(received).toEqual([{
        sender: 'deck_sub_worker',
        body: expect.objectContaining({
          version: 'peer_audit_reply_v1',
          attemptId: 'attempt_12345678',
          replyCapability: 'A'.repeat(32),
        }),
      }]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => hookServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('submits delegation_reply to dedicated ingress with the runtime-bound sender header', async () => {
    const home = await mkdtemp(join(tmpdir(), 'imcodes-mcp-delegation-reply-'));
    await writeSessionStore(home);
    const received: Array<{ body: Record<string, unknown>; sender?: string }> = [];
    const hookServer = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/delegation-reply') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received.push({
          body: JSON.parse(raw) as Record<string, unknown>,
          sender: typeof req.headers['x-imcodes-session'] === 'string' ? req.headers['x-imcodes-session'] : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          delivered: false,
          pending: true,
          reason: AGENT_DELEGATION_REPLY_ERRORS.DELIVERY_PENDING,
        }));
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const address = hookServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP hook server address');
    await writeFile(join(home, '.imcodes', 'hook-port'), String(address.port), 'utf8');
    const client = new Client({ name: 'memory-mcp-delegation-reply-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env: mcpEnv(home),
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const result = await callLazyTool(client, 'delegation_reply', {
          delegationId: 'delegation_identity_1234567890',
          replyCapability: 'reply_capability_1234567890_ABCDEFG',
          result: 'Completed with exact evidence.',
      });
      expect(result.structuredContent).toEqual({
        status: 'ok',
        accepted: true,
        delivered: false,
        pending: true,
      });
      expect(received).toEqual([{
        sender: 'deck_sub_worker',
        body: {
          version: 'agent_delegation_reply_v1',
          delegationId: 'delegation_identity_1234567890',
          replyCapability: 'reply_capability_1234567890_ABCDEFG',
          result: 'Completed with exact evidence.',
        },
      }]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => hookServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('bounds a delegation hook request when the daemon accepts the socket but never replies', async () => {
    const hookServer = createServer((_req, _res) => {
      // Deliberately leave the response open: this is the daemon-side hang
      // that previously left the MCP tool running until the user pressed Stop.
    });
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const address = hookServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP hook server address');
    try {
      await expect(postHookSend(
        address.port,
        { result: 'done' },
        '/delegation-reply',
        'deck_sub_worker',
        25,
      )).rejects.toThrow('hook request timed out after 25ms');
    } finally {
      await new Promise<void>((resolve, reject) => hookServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('keeps listed send targets usable across a transient empty session-store refresh', async () => {
    const home = await mkdtemp(join(tmpdir(), 'imcodes-mcp-send-stable-'));
    await writeSessionStore(home);
    const hookBodies: Array<Record<string, unknown>> = [];
    const hookServer = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/send') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        hookBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body.deliveryMode === 'queue'
          ? { ok: true, queued: true, target: body.to }
          : { ok: true, delivered: true, target: body.to }));
      });
    });

    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const address = hookServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP hook server address');
    await writeFile(join(home, '.imcodes', 'hook-port'), String(address.port), 'utf8');

    const client = new Client({ name: 'memory-mcp-stable-send-target-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env: mcpEnv(home),
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const listed = await callLazyTool(client, 'send_list_targets', { query: 'claude-opus' });
      expect(listed.structuredContent).toMatchObject({
        status: 'ok',
        items: [expect.objectContaining({
          target: 'deck_sub_peer',
          label: 'Peer',
          model: 'claude-opus-4-8',
        })],
      });

      await writeFile(join(home, '.imcodes', 'sessions.json'), JSON.stringify({ sessions: {} }), 'utf8');

      const sent = await callLazyTool(client, 'send_message', {
          target: 'deck_sub_peer',
          message: 'hello after transient empty store',
      });

      expect(sent.structuredContent).toMatchObject({
        status: 'accepted',
        deliveries: [expect.objectContaining({ target: 'deck_sub_peer', status: 'delivered' })],
      });
      expect(hookBodies).toEqual([{
        from: 'deck_sub_worker',
        to: 'deck_sub_peer',
        message: 'hello after transient empty store',
        depth: 0,
        deliveryMode: 'append',
      }]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => hookServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe('mergeDefaultToolDeps per-field composition', () => {
  const caller: McpRuntimeCaller = {
    userId: 'user-1',
    namespace: namespace as McpRuntimeCaller['namespace'],
    sessionName: 'deck_sub_worker',
    projectName: 'proj',
    projectRoot: '/tmp/proj',
    serverId: 'srv-1',
    transport: 'stdio',
  };

  it('composes default cancelSession, capability + limit resolvers when only dispatchMessage is injected', () => {
    const dispatchSpy = vi.fn(async () => {});
    const merged = mergeDefaultToolDeps(caller, {
      // ONLY a custom dispatcher — no cancelSession, no resolveExecutionCloneLimits,
      // no isExecutionCloneCapabilityEnabled. The old early-return dropped all three.
      sendDeps: { dispatchMessage: dispatchSpy },
    });

    // The injected dispatcher must be the one preserved (not clobbered by the default).
    expect(merged.sendDeps?.dispatchMessage).toBe(dispatchSpy);

    // ...and the other three production defaults must STILL compose.
    expect(typeof merged.sendDeps?.cancelSession).toBe('function');
    expect(typeof merged.sendDeps?.resolveExecutionCloneLimits).toBe('function');
    expect(typeof merged.sendDeps?.isExecutionCloneCapabilityEnabled).toBe('function');
    expect(merged.capabilityService).toBeDefined();

    // The composed limit resolver is backed by the daemon resolver (mocked cap=1),
    // proving it is wired without a manual inject.
    expect(merged.sendDeps?.resolveExecutionCloneLimits?.('run-x')).toMatchObject({
      maxParallelClones: 1,
    });
  });

  it('keeps capability management absent when the scoped daemon identity is unavailable', () => {
    const merged = mergeDefaultToolDeps({ ...caller, serverId: null }, {});
    expect(merged.capabilityService).toBeUndefined();
  });
});

describe('createMemoryMcpServerFromEnv supervision wiring', () => {
  // Regression: createMemoryMcpServer takes four parameters, but FromEnv passed
  // only three, so supervisionToolDeps silently fell back to {} and every
  // task-registry call failed with "registry not bound" on every start. No crash
  // was needed for the symptom, which is why it survived unnoticed.
  //
  // This asserts the ACTUAL forwarded argument. An earlier attempt only checked
  // the options type with `as never` casts and stayed green when the fix was
  // reverted, i.e. it proved nothing.
  it('forwards supervisionToolDeps to registerSupervisionMcpTools', async () => {
    vi.resetModules();
    const seen: unknown[] = [];
    vi.doMock('../../src/daemon/supervision-mcp-tools.js', () => ({
      registerSupervisionMcpTools: (_s: unknown, _c: unknown, deps: unknown) => {
        seen.push(deps);
        return new Map();
      },
    }));
    const mod = await import('../../src/daemon/memory-mcp-server.js');
    const marker = { boundRegistry: Symbol('registry') };
    mod.createMemoryMcpServerFromEnv({
      env: { IMCODES_MCP_CALLER_SERVER_ID: 's1', IMCODES_MCP_CALLER_SESSION_NAME: 'deck_x' },
      supervisionToolDeps: marker as never,
    });
    vi.doUnmock('../../src/daemon/supervision-mcp-tools.js');
    vi.resetModules();
    expect(seen).toHaveLength(1);
    // Reverting the wiring makes this undefined (deps default to {}), so the
    // assertion is load-bearing rather than decorative.
    expect(seen[0]).toBe(marker);
  });
});
