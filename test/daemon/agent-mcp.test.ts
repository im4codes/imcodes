import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MCP_ERROR,
  AGENT_MCP_MSG,
  AGENT_MCP_REGISTRY,
  readAgentMcpRunRequest,
  readAgentMcpServerSpec,
} from '../../shared/agent-mcp.js';
import {
  describeAgentMcpConfig,
  handleAgentMcpCommand,
  listAgentMcp,
  runAgentMcp,
  searchAgentMcpRegistry,
  type AgentMcpSdk,
} from '../../src/daemon/agent-mcp.js';

const execFileAsync = promisify(execFile);

function fakeSdk(installed: Record<string, Record<string, Record<string, unknown>>>, detected = Object.keys(installed)) {
  const configs = structuredClone(installed);
  const sdk: AgentMcpSdk = {
    agents: {
      'claude-code': { displayName: 'Claude Code', supportedTransports: ['stdio', 'http', 'sse'] },
      codex: { displayName: 'Codex', supportedTransports: ['stdio', 'http'] },
      'gemini-cli': { displayName: 'Gemini CLI', supportedTransports: ['stdio', 'http', 'sse'] },
    },
    detectGlobalAgents: vi.fn(async () => detected),
    listInstalledServers: vi.fn(async () => Object.entries(configs).map(([agentType, servers]) => ({
      agentType,
      displayName: agentType,
      detected: detected.includes(agentType),
      servers: Object.entries(servers).map(([serverName, config]) => ({ serverName, config, identity: serverName })),
    }))),
    upsertServer: vi.fn((agent: string, name: string, config: Record<string, unknown>) => {
      configs[agent] = { ...(configs[agent] ?? {}), [name]: config };
      return { success: true };
    }),
    removeServer: vi.fn((agent: string, name: string) => {
      const had = Boolean(configs[agent]?.[name]);
      if (had) delete configs[agent]![name];
      return { success: true, removed: had };
    }),
  };
  return sdk;
}

describe('listing MCP servers', () => {
  it('merges a server across agents and shows no secret: no values, no arguments', async () => {
    const sdk = fakeSdk({
      'claude-code': {
        github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/?token=abc', headers: { Authorization: 'Bearer ghp_secret' } },
        db: { command: 'npx', args: ['-y', '@bytebase/dbhub', '--dsn', 'postgres://u:pw@h/db'], env: { PGPASSWORD: 'pw' } },
        'imcodes-memory': { command: 'imcodes', args: ['memory', 'mcp'] },
      },
      codex: { github: { url: 'https://api.githubcopilot.com/mcp/', http_headers: { Authorization: 'Bearer ghp_secret' } } },
    });
    const list = await listAgentMcp(sdk);
    const text = JSON.stringify(list);
    expect(text).not.toContain('ghp_secret');
    expect(text).not.toContain('pw@');
    expect(text).not.toContain('token=abc');
    expect(list.servers.find((server) => server.name === 'github')).toEqual({
      name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
      envNames: [], headerNames: ['Authorization'], agents: ['claude-code', 'codex'],
    });
    expect(list.servers.find((server) => server.name === 'db')).toEqual({
      name: 'db', transport: 'stdio', command: 'npx', packageName: '@bytebase/dbhub',
      envNames: ['PGPASSWORD'], headerNames: [], agents: ['claude-code'],
    });
    expect(list.agents.map((agent) => agent.agent)).toEqual(['claude-code', 'codex']);
  });

  it('reads OpenCode-style command arrays', () => {
    expect(describeAgentMcpConfig('x', { type: 'local', command: ['bunx', 'some-mcp', '--port', '1'], environment: { K: 'v' } }))
      .toEqual({ name: 'x', transport: 'stdio', command: 'bunx', packageName: 'some-mcp', envNames: ['K'], headerNames: [] });
  });
});

describe('adding and removing', () => {
  it('adds to every detected agent that can speak the transport, in its canonical form', async () => {
    const sdk = fakeSdk({ 'claude-code': {}, codex: {}, 'gemini-cli': {} });
    const result = await runAgentMcp({
      action: 'add',
      server: { name: 'events', transport: 'sse', url: 'https://example.com/sse', headers: { 'X-Key': 'k' } },
    }, sdk);
    // Codex cannot take SSE here, so it is not written to.
    expect(result.results).toEqual([{ agent: 'claude-code', ok: true }, { agent: 'gemini-cli', ok: true }]);
    expect(sdk.upsertServer).toHaveBeenCalledWith('claude-code', 'events', { type: 'sse', url: 'https://example.com/sse', headers: { 'X-Key': 'k' } }, { local: false });
    expect(result.ok).toBe(true);
    expect(result.list?.servers.map((server) => server.name)).toEqual(['events']);
  });

  it('reports when no agent on the machine can take the server', async () => {
    const sdk = fakeSdk({ codex: {} });
    const result = await runAgentMcp({ action: 'add', server: { name: 'events', transport: 'sse', url: 'https://example.com/sse' } }, sdk);
    expect(result).toMatchObject({ ok: false, error: AGENT_MCP_ERROR.NO_AGENTS });
    expect(sdk.upsertServer).not.toHaveBeenCalled();
  });

  it('removes a server only from the agents that have it, and never IM.codes\' own', async () => {
    const sdk = fakeSdk({ 'claude-code': { db: { command: 'x' } }, codex: {}, 'gemini-cli': { db: { command: 'x' } } });
    const removed = await runAgentMcp({ action: 'remove', name: 'db' }, sdk);
    expect(removed.results?.map((result) => result.agent)).toEqual(['claude-code', 'gemini-cli']);
    expect(await runAgentMcp({ action: 'remove', name: 'imcodes-memory' }, sdk)).toEqual({ ok: false, error: AGENT_MCP_ERROR.RESERVED_NAME });
  });
});

describe('requests', () => {
  it('accepts an npx server with variables and a remote https server with headers', () => {
    expect(readAgentMcpServerSpec({ name: 'dbhub', transport: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub'], env: { DSN: 'postgres://x' } }))
      .toEqual({ name: 'dbhub', transport: 'stdio', command: 'npx', args: ['-y', '@bytebase/dbhub'], env: { DSN: 'postgres://x' } });
    expect(readAgentMcpServerSpec({ name: 'gh', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer t' } }))
      .toMatchObject({ name: 'gh', url: 'https://api.githubcopilot.com/mcp/' });
  });

  it('refuses shell syntax, cleartext remote hosts, header injection and IM.codes\' own name', () => {
    for (const bad of [
      { name: 'x', transport: 'stdio', command: 'npx; rm -rf ~' },
      { name: 'x', transport: 'stdio', command: 'sh -c evil' },
      { name: 'x', transport: 'http', url: 'http://example.com/mcp' },
      { name: 'x', transport: 'http', url: 'https://user:pw@example.com/mcp' },
      { name: 'x', transport: 'http', url: 'https://example.com/mcp', headers: { A: 'v\r\nInjected: 1' } },
      { name: 'x', transport: 'stdio', command: 'npx', env: { 'BAD NAME': 'v' } },
      { name: 'imcodes-memory', transport: 'stdio', command: 'npx' },
      { name: '../x', transport: 'stdio', command: 'npx' },
    ]) {
      expect(readAgentMcpServerSpec(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(readAgentMcpServerSpec({ name: 'local', transport: 'http', url: 'http://localhost:8080/mcp' })).not.toBeNull();
    expect(readAgentMcpRunRequest({ action: 'remove', name: 'imcodes-memory' })).toBeNull();
  });

  it('answers an invalid request without touching any config', async () => {
    const sdk = fakeSdk({ 'claude-code': {} });
    const sent: Array<Record<string, unknown>> = [];
    await handleAgentMcpCommand({ type: AGENT_MCP_MSG.RUN_REQUEST, requestId: 'r1', action: 'add', server: { name: 'x', transport: 'stdio', command: 'a;b' } }, (m) => sent.push(m), sdk);
    expect(sent).toEqual([{ type: AGENT_MCP_MSG.RUN_RESPONSE, requestId: 'r1', ok: false, error: AGENT_MCP_ERROR.INVALID_REQUEST }]);
    expect(sdk.upsertServer).not.toHaveBeenCalled();
  });
});

describe('registry lookup and isolated real add-mcp filesystem round-trip', () => {
  it('queries official MCP registry via searchAgentMcpRegistry and handles errors cleanly', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      servers: [
        {
          server: {
            name: 'io.upstash/context7',
            description: 'Upstash Context7 MCP',
            version: '1.0.0',
            remotes: [{ type: 'streamable-http', url: 'https://mcp.context7.com/mcp' }],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
        },
      ],
    }), { status: 200 }));
    const results = await searchAgentMcpRegistry('context7', fetchImpl as unknown as typeof fetch);
    expect(results).toEqual([
      {
        id: 'io.upstash/context7',
        description: 'Upstash Context7 MCP',
        version: '1.0.0',
        remote: { transport: 'http', url: 'https://mcp.context7.com/mcp', headers: [] },
      },
    ]);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown as [string])[0]));
    expect(`${url.origin}${url.pathname}`).toBe(AGENT_MCP_REGISTRY.SEARCH_URL);
    expect(url.searchParams.get('search')).toBe('context7');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('version')).toBe('latest');

    const failFetch = vi.fn(async () => new Response('down', { status: 503 }));
    await expect(searchAgentMcpRegistry('context7', failFetch as unknown as typeof fetch)).rejects.toThrow('registry_http_503');
  });

  it('installs, lists, and uninstalls stdio + Streamable HTTP MCPs via real add-mcp in an isolated temp HOME', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'imcodes-add-mcp-isolated-'));
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    mkdirSync(join(tempHome, '.gemini'), { recursive: true });

    const repoRoot = resolve(import.meta.dirname, '../..');
    const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx');
    const scriptPath = join(tempHome, 'roundtrip.mts');
    const scriptSource = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href)};
import { InMemoryTransport } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js')).href)};
import { listAgentMcp, runAgentMcp } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'src/daemon/agent-mcp.ts')).href)};
import { createMemoryMcpServer } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'src/daemon/memory-mcp-server.ts')).href)};
import { CAPABILITY_ERROR } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'shared/capability-management.ts')).href)};
import { MCP_TOOL_DISCOVERY_NAME } from ${JSON.stringify(pathToFileURL(resolve(repoRoot, 'shared/mcp-tool-discovery.ts')).href)};

async function main() {
const tempHome = process.env.HOME!;
const mockService = {
  list: async () => ({ status: 'ok' as const, items: [] }),
  install: async () => ({ status: 'error' as const, reason: CAPABILITY_ERROR.INVALID_INPUT, error: 'unused' }),
  status: async () => ({ status: 'ok' as const }),
  manage: async () => ({ status: 'error' as const, reason: CAPABILITY_ERROR.NOT_FOUND, error: 'not found' }),
};

const server = createMemoryMcpServer({
  userId: 'owner-1',
  namespace: { scope: 'user_private', userId: 'owner-1', projectId: 'project-1' },
  sessionName: 'deck_project_brain',
  projectName: 'project',
  projectRoot: '/tmp/project',
  serverId: 'server-1',
  providerId: 'codex-sdk',
  transport: 'in_process',
}, {
  capabilityService: mockService,
  listAgentMcp: () => listAgentMcp(),
  runAgentMcp: (req) => runAgentMcp(req),
});

const client = new Client({ name: 'isolated-add-mcp-roundtrip', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'group:capability-management' } });

  const installHttp = await client.callTool({
    name: 'capability_install',
    arguments: {
      kind: 'mcp',
      source: { kind: 'mcp_config', mcpConfig: { transport: 'streamable_http', url: 'https://mcp.context7.com/mcp' } },
    },
  });
  assert.equal(installHttp.isError, false, JSON.stringify(installHttp.structuredContent));
  assert.equal((installHttp.structuredContent as any).server, 'context7');

  const installStdio = await client.callTool({
    name: 'capability_install',
    arguments: {
      kind: 'mcp',
      source: {
        kind: 'mcp_config',
        mcpConfig: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
      },
    },
  });
  assert.equal(installStdio.isError, false, JSON.stringify(installStdio.structuredContent));
  assert.equal((installStdio.structuredContent as any).server, 'server-sequential-thinking');

  const claudeJson = JSON.parse(readFileSync(join(tempHome, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
  const geminiJson = JSON.parse(readFileSync(join(tempHome, '.gemini', 'settings.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
  const codexToml = readFileSync(join(tempHome, '.codex', 'config.toml'), 'utf8');
  assert.ok(claudeJson.mcpServers.context7);
  assert.ok(claudeJson.mcpServers['server-sequential-thinking']);
  assert.ok(geminiJson.mcpServers.context7);
  assert.ok(codexToml.includes('context7'));
  assert.ok(codexToml.includes('server-sequential-thinking'));

  const listed = await client.callTool({ name: 'capability_list', arguments: { kind: 'mcp' } });
  assert.equal(listed.isError, false);
  const items = (listed.structuredContent as any).items as Array<{ name: string; transport: string }>;
  assert.ok(items.some((i) => i.name === 'context7' && i.transport === 'http'));
  assert.ok(items.some((i) => i.name === 'server-sequential-thinking' && i.transport === 'stdio'));

  const rm1 = await client.callTool({
    name: 'capability_manage',
    arguments: { action: 'uninstall', kind: 'mcp', name: 'context7', userIntent: 'uninstall context7' },
  });
  assert.equal(rm1.isError, false);
  assert.equal((rm1.structuredContent as any).removed, 'context7');

  const rm2 = await client.callTool({
    name: 'capability_manage',
    arguments: { action: 'uninstall', name: 'server-sequential-thinking', userIntent: 'uninstall sequential-thinking' },
  });
  assert.equal(rm2.isError, false);
  assert.equal((rm2.structuredContent as any).removed, 'server-sequential-thinking');

  const listedAfter = await client.callTool({ name: 'capability_list', arguments: { kind: 'mcp' } });
  assert.deepEqual((listedAfter.structuredContent as any).items, []);
} finally {
  await client.close();
  await server.close();
}
}
main().catch((err) => { console.error(err); process.exit(1); });
`;
    writeFileSync(scriptPath, scriptSource, 'utf8');

    try {
      await execFileAsync(tsxBin, [scriptPath], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          XDG_CONFIG_HOME: join(tempHome, '.config'),
          CODEX_HOME: join(tempHome, '.codex'),
          CLAUDE_CONFIG_DIR: join(tempHome, '.claude'),
          COPILOT_HOME: join(tempHome, '.copilot'),
          KIMI_CODE_HOME: join(tempHome, '.kimi-code'),
          GROK_HOME: join(tempHome, '.grok'),
          PI_CODING_AGENT_DIR: join(tempHome, '.pi', 'agent'),
        },
        timeout: 20_000,
      });

      // Sanity check tempHome files had servers removed cleanly
      const claudeAfter = JSON.parse(readFileSync(join(tempHome, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
      expect(claudeAfter.mcpServers?.context7).toBeUndefined();
      expect(claudeAfter.mcpServers?.['server-sequential-thinking']).toBeUndefined();
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 25_000);
});
