/**
 * Real scoped run of the field failure (tsk_4b924944b6): the stdio MCP server is a separate PROCESS from the daemon. pair_create used to
 * run inside that child, launching the pair's sub-session into the child's private session map and provider registry: the daemon and the
 * server never saw it (`session_not_found`, never in the sidebar) while the pair said "dispatched".
 *
 * This test spawns the real child under a scoped HOME with a fake daemon hook server and proves pair_create is handed to the daemon
 * (`/memory-mcp/tool`, under the Brain's authenticated session name) and that the child launches and persists nothing itself.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { SHARED_MACHINE_AUTHORITY_HOOK_PATH } from '../../../shared/shared-machine-authority.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MEMORY_MCP_ENV_KEYS, buildMemoryMcpServerEnv } from '../../../shared/memory-mcp-env.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_DAEMON_RPC_PATH } from '../../../shared/memory-mcp-daemon-rpc.js';
import { SESSION_RESOURCE_OWNER_ENV } from '../../../shared/session-resource-lifecycle.js';

const namespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };

describe('pair_create called through the real stdio MCP child', () => {
  it('is handed to the daemon under the Brain session, and the child creates no session of its own', async () => {
    const home = await mkdtemp(join(tmpdir(), 'imcodes-pair-create-daemon-'));
    const imcodesDir = join(home, '.imcodes');
    await mkdir(imcodesDir, { recursive: true });
    const now = Date.now();
    const brain = {
      name: 'deck_proj_brain', projectName: 'proj', role: 'brain', agentType: 'claude-code-sdk', projectDir: join(home, 'proj'), state: 'idle',
      restarts: 0, restartTimestamps: [], createdAt: now, updatedAt: now, runtimeType: 'transport',
      sessionInstanceId: 'instance-brain', runtimeEpoch: 'epoch-brain',
    };
    const sessionsFile = join(imcodesDir, 'sessions.json');
    await writeFile(sessionsFile, JSON.stringify({ sessions: { deck_proj_brain: brain } }), 'utf8');

    const received: Array<{ tool?: unknown; input?: unknown; sender?: string }> = [];
    const hookServer = createServer((req, res) => {
      if (req.method === 'POST' && req.url === SHARED_MACHINE_AUTHORITY_HOOK_PATH) {
        // The stdio child asks whose turn this is before it runs an owner-level tool; this is the owner's own turn.
        req.resume();
        req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, required: false, authority: null })); });
        return;
      }
      if (req.method !== 'POST' || req.url !== MEMORY_MCP_DAEMON_RPC_PATH) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        received.push({ tool: body.tool, input: body.input, sender: typeof req.headers['x-imcodes-session'] === 'string' ? req.headers['x-imcodes-session'] : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { status: 'ok', ranIn: 'daemon', taskId: 'tsk_from_daemon' } }));
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    const address = hookServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP hook server address');
    await writeFile(join(imcodesDir, 'hook-port'), String(address.port), 'utf8');

    const env = {
      ...buildMemoryMcpServerEnv({
        [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
        [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify(namespace),
        [MEMORY_MCP_ENV_KEYS.SESSION_NAME]: 'deck_proj_brain',
        [MEMORY_MCP_ENV_KEYS.PROJECT_NAME]: 'proj',
        [MEMORY_MCP_ENV_KEYS.PROJECT_ROOT]: join(home, 'proj'),
        [MEMORY_MCP_ENV_KEYS.SERVER_ID]: 'srv-1',
      }, { PATH: process.env.PATH, HOME: home }),
      [SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]: 'instance-brain',
      [SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]: 'epoch-brain',
    };
    const client = new Client({ name: 'pair-create-daemon-test', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
      cwd: process.cwd(),
      env,
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      const activation = await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'pair_create' } });
      expect(activation.isError).not.toBe(true);
      const result = await client.callTool({ name: 'pair_create', arguments: { brief: '# real child', title: 'Real child' } });
      expect(result.structuredContent).toMatchObject({ status: 'ok', ranIn: 'daemon', taskId: 'tsk_from_daemon' });
      expect(received).toEqual([{ tool: 'pair_create', input: expect.objectContaining({ brief: '# real child' }), sender: 'deck_proj_brain' }]);
      // the child's own store gained no session: it launched nothing
      const after = JSON.parse(await readFile(sessionsFile, 'utf8')) as { sessions: Record<string, unknown> };
      expect(Object.keys(after.sessions)).toEqual(['deck_proj_brain']);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => hookServer.close((err) => (err ? reject(err) : resolve())));
    }
  }, 60_000);
});
