import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MEMORY_MCP_ENV_KEYS, buildMemoryMcpServerEnv } from '../../shared/memory-mcp-env.js';
import { MEMORY_MCP_TOOL_NAME_LIST } from '../../shared/memory-mcp-contracts.js';
import { createMemoryMcpServerFromEnv } from '../../src/daemon/memory-mcp-server.js';

const namespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };

async function writeSessionStore(home: string): Promise<void> {
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
        restarts: 0,
        restartTimestamps: [],
        createdAt: now,
        updatedAt: now,
        parentSession: 'deck_proj_brain',
        runtimeType: 'transport',
        label: 'Peer',
      },
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
      expect(listed.tools.map((tool) => tool.name)).toEqual([...MEMORY_MCP_TOOL_NAME_LIST]);
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
      const result = await client.callTool({ name: 'send_list_targets', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        status: 'ok',
        items: [
          expect.objectContaining({ target: 'deck_proj_brain' }),
          expect.objectContaining({ target: 'deck_sub_peer', label: 'Peer' }),
        ],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain('deck_sub_worker');
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
        hookBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, delivered: true, target: 'deck_sub_peer' }));
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
      const result = await client.callTool({
        name: 'send_message',
        arguments: {
          target: 'deck_sub_peer',
          message: 'hello from stdio mcp',
        },
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
      }]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => hookServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
