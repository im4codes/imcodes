import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MCP_ERROR,
  AGENT_MCP_MSG,
  readAgentMcpRunRequest,
  readAgentMcpServerSpec,
} from '../../shared/agent-mcp.js';
import {
  describeAgentMcpConfig,
  handleAgentMcpCommand,
  listAgentMcp,
  runAgentMcp,
  type AgentMcpSdk,
} from '../../src/daemon/agent-mcp.js';

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
