import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MEMORY_MCP_ENV_KEYS, buildMemoryMcpServerEnv } from '../../shared/memory-mcp-env.js';
import { MEMORY_MCP_TOOL_NAME_LIST } from '../../shared/memory-mcp-contracts.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';

const namespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };

describe('memory MCP stdio server', () => {
  it('fails fast for missing env and invalid namespace', async () => {
    expect(() => createMemoryMcpServerFromEnv({ env: {} })).toThrow('IMCODES_DAEMON_{USER_ID,NAMESPACE} required');
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

  it('lists exactly the ten shared tools over stdio and does not leak secret env', async () => {
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
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...MEMORY_MCP_TOOL_NAME_LIST]);
      for (const tool of listed.tools) {
        expect(tool.description).toBeTruthy();
      }
      expect(JSON.stringify(listed)).not.toContain('server-secret');
      expect(JSON.stringify(listed)).not.toContain('api-secret');
    } finally {
      await client.close();
    }

    expect(readFileSync(serverConfigPath, 'utf8')).not.toContain('userId');
  });
});
