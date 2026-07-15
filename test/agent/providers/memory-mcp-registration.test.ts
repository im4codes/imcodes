import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PROCESS_SESSION_AGENT_TYPES,
  TRANSPORT_SESSION_AGENT_TYPES,
} from '../../../shared/agent-types.js';
import { IMCODES_SESSION_ENV } from '../../../shared/imcodes-send.js';
import {
  buildMemoryMcpServerEnv,
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
  isMemoryMcpAllowedEnvKey,
} from '../../../shared/memory-mcp-env.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import {
  MEMORY_MCP_PROVIDER_ID,
  MEMORY_MCP_PROVIDER_IDS,
} from '../../../shared/memory-ws.js';
import { getDefaultCodexMcpArgs } from '../../../src/agent/providers/getDefaultCodexMcpArgs.js';
import {
  getDefaultAcpMcpServers,
  getDefaultMcpServers,
} from '../../../src/agent/providers/getDefaultMcpServers.js';

const sessionConfig = {
  sessionKey: 'route-1',
  sessionName: 'deck_alpha_worker',
  projectName: 'alpha',
  serverId: 'srv-bound',
  cwd: '/tmp/project',
  env: {
    [IMCODES_SESSION_ENV]: 'deck_alpha_worker',
    IMCODES_SERVER_TOKEN: 'server-secret',
    OAUTH_TOKEN: 'oauth-secret',
  },
  contextNamespace: {
    scope: 'user_private' as const,
    userId: 'user-secret-ish',
    projectId: 'github.com/acme/project',
  },
};

describe('managed provider MCP registration helpers', () => {
  it('pins the exact nine managed provider matrix and excludes process/OpenClaw providers', () => {
    expect(MEMORY_MCP_PROVIDER_IDS).toEqual([
      MEMORY_MCP_PROVIDER_ID.CLAUDE_CODE_SDK,
      MEMORY_MCP_PROVIDER_ID.GEMINI_SDK,
      MEMORY_MCP_PROVIDER_ID.GROK_SDK,
      MEMORY_MCP_PROVIDER_ID.KIMI_SDK,
      MEMORY_MCP_PROVIDER_ID.COPILOT_SDK,
      MEMORY_MCP_PROVIDER_ID.CODEX_SDK,
      MEMORY_MCP_PROVIDER_ID.QODER_SDK,
      MEMORY_MCP_PROVIDER_ID.CURSOR_HEADLESS,
      MEMORY_MCP_PROVIDER_ID.QWEN,
    ]);

    expect(TRANSPORT_SESSION_AGENT_TYPES.filter((agentType) => (
      !MEMORY_MCP_PROVIDER_IDS.includes(agentType as (typeof MEMORY_MCP_PROVIDER_IDS)[number])
    ))).toEqual(['openclaw']);
    expect(PROCESS_SESSION_AGENT_TYPES.some((agentType) => (
      MEMORY_MCP_PROVIDER_IDS.includes(agentType as (typeof MEMORY_MCP_PROVIDER_IDS)[number])
    ))).toBe(false);
  });

  it('builds a minimal stdio server config without forwarding daemon secrets', () => {
    const servers = getDefaultMcpServers(sessionConfig);
    const server = servers[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(server).toMatchObject({
      type: 'stdio',
      command: 'imcodes',
      args: ['memory', 'mcp'],
    });
    expect(server.env[IMCODES_DAEMON_USER_ID_ENV]).toBe('user-secret-ish');
    expect(JSON.parse(server.env[IMCODES_DAEMON_NAMESPACE_ENV])).toEqual({
      scope: 'user_private',
      userId: 'user-secret-ish',
      projectId: 'github.com/acme/project',
    });
    expect(server.env[IMCODES_DAEMON_SESSION_NAME_ENV]).toBe('deck_alpha_worker');
    expect(server.env[IMCODES_DAEMON_PROJECT_NAME_ENV]).toBe('alpha');
    expect(server.env[IMCODES_DAEMON_PROJECT_ROOT_ENV]).toBe('/tmp/project');
    expect(server.env[IMCODES_DAEMON_SERVER_ID_ENV]).toBe('srv-bound');
    expect(server.env.IMCODES_SERVER_TOKEN).toBeUndefined();
    expect(server.env.OAUTH_TOKEN).toBeUndefined();
    expect(Object.keys(server.env).every(isMemoryMcpAllowedEnvKey)).toBe(true);
  });

  it('fills daemon-local identity for local personal namespaces without user ids', () => {
    const servers = getDefaultMcpServers({
      ...sessionConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'github.com/acme/project',
      },
    });
    const server = servers[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(server.env[IMCODES_DAEMON_USER_ID_ENV]).toBe('daemon-local');
    expect(JSON.parse(server.env[IMCODES_DAEMON_NAMESPACE_ENV])).toEqual({
      scope: 'personal',
      userId: 'daemon-local',
      projectId: 'github.com/acme/project',
    });
  });

  it('allow-lists MCP child env even when the source process env has secrets', () => {
    const env = buildMemoryMcpServerEnv({
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-1',
      [IMCODES_DAEMON_NAMESPACE_ENV]: '{"scope":"personal","userId":"user-1"}',
    }, {
      PATH: '/bin',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--no-warnings',
      IMCODES_SERVER_TOKEN: 'server-secret',
      OPENAI_API_KEY: 'api-secret',
      RANDOM_ENV: 'nope',
    });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--no-warnings',
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-1',
      [IMCODES_DAEMON_NAMESPACE_ENV]: '{"scope":"personal","userId":"user-1"}',
    });
  });

  it('builds ACP-shaped env entries for Gemini user sessions', () => {
    const [server] = getDefaultAcpMcpServers(sessionConfig);

    expect(server.name).toBe(IMCODES_MEMORY_MCP_SERVER_NAME);
    expect(server.command).toBe('imcodes');
    expect(server.args).toEqual(['memory', 'mcp']);
    expect(server.env).toContainEqual({ name: IMCODES_DAEMON_USER_ID_ENV, value: 'user-secret-ish' });
    expect(server.env.some((entry) => entry.name === 'IMCODES_SERVER_TOKEN')).toBe(false);
  });

  it('uses explicit sub-session identity and parent project instead of inferring project from deck_sub names or labels', () => {
    const servers = getDefaultMcpServers({
      ...sessionConfig,
      sessionKey: 'route-sub',
      sessionName: 'deck_sub_abc123',
      projectName: 'alpha',
      label: 'friendly-worker',
      env: {},
    });
    const server = servers[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(server.env[IMCODES_DAEMON_SESSION_NAME_ENV]).toBe('deck_sub_abc123');
    expect(server.env[IMCODES_DAEMON_PROJECT_NAME_ENV]).toBe('alpha');
    expect(server.env[IMCODES_DAEMON_SESSION_NAME_ENV]).not.toBe('friendly-worker');
  });

  it('keeps Codex app-server startup argv free of daemon identity values', () => {
    const args = getDefaultCodexMcpArgs();
    const serialized = JSON.stringify(args);

    expect(serialized).toContain(IMCODES_MEMORY_MCP_SERVER_NAME);
    expect(serialized).toContain('imcodes');
    expect(serialized).toContain('memory');
    expect(serialized).not.toContain(IMCODES_DAEMON_USER_ID_ENV);
    expect(serialized).not.toContain(IMCODES_DAEMON_NAMESPACE_ENV);
    expect(serialized).not.toContain('user-secret-ish');
    expect(serialized).not.toContain('github.com/acme/project');
  });

  it('pins Gemini model-list probe as MCP-free', async () => {
    const source = await readFile(new URL('../../../src/agent/providers/gemini-sdk.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/listModels[\s\S]*newSession\(\{\s*cwd:[\s\S]*mcpServers:\s*\[\]/);
  });
});
