import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import http from 'http';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import {
  MemoryMcpCallerEnvError,
  parseMcpRuntimeCallerFromEnv,
  type McpRuntimeCaller,
} from './memory-mcp-caller.js';
import { registerMemoryMcpTools, type MemoryMcpToolDeps } from './memory-mcp-tools.js';
import { loadStore, type SessionRecord } from '../store/session-store.js';

export interface MemoryMcpServerOptions {
  env?: Record<string, string | undefined>;
  toolDeps?: MemoryMcpToolDeps;
}

export function createMemoryMcpServer(caller: McpRuntimeCaller, toolDeps: MemoryMcpToolDeps = {}): McpServer {
  const server = new McpServer({
    name: IMCODES_MEMORY_MCP_SERVER_NAME,
    version: '0.1.0',
  });
  registerMemoryMcpTools(server, caller, toolDeps);
  return server;
}

function readHookPort(): number | null {
  try {
    const raw = readFileSync(join(homedir(), '.imcodes', 'hook-port'), 'utf8').trim();
    const port = Number.parseInt(raw, 10);
    return Number.isFinite(port) && port > 1024 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function postHookSend(port: number, body: Record<string, unknown>, hookPath = '/send'): Promise<Record<string, unknown>> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: hookPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
          if ((res.statusCode ?? 500) >= 400 || parsed.ok === false) {
            reject(new Error(typeof parsed.error === 'string' ? parsed.error : `hook send failed with status ${res.statusCode ?? 0}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function mergeDefaultToolDeps(caller: McpRuntimeCaller, toolDeps: MemoryMcpToolDeps): MemoryMcpToolDeps {
  if (toolDeps.sendDeps?.dispatchMessage) return toolDeps;
  return {
    ...toolDeps,
    sendDeps: {
      ...toolDeps.sendDeps,
      dispatchMessage: async (target: SessionRecord, message: string) => {
        const port = readHookPort();
        if (!port) throw new Error('daemon hook server is unavailable');
        if (!caller.sessionName) throw new Error('send_message requires a scoped caller');
        await postHookSend(port, {
          from: caller.sessionName,
          to: target.name,
          message,
          depth: 0,
        });
      },
      cancelSession: async (target: SessionRecord) => {
        const port = readHookPort();
        if (!port) throw new Error('daemon hook server is unavailable');
        if (!caller.sessionName) throw new Error('send_stop requires a scoped caller');
        const res = await postHookSend(port, {
          from: caller.sessionName,
          to: target.name,
        }, '/stop');
        return (res as { stopped?: boolean }).stopped !== false;
      },
    },
  };
}

export function createMemoryMcpServerFromEnv(options: MemoryMcpServerOptions = {}): McpServer {
  const caller = parseMcpRuntimeCallerFromEnv(options.env ?? process.env, 'stdio');
  return createMemoryMcpServer(caller, mergeDefaultToolDeps(caller, options.toolDeps ?? {}));
}

export async function runMemoryMcpServer(options: MemoryMcpServerOptions = {}): Promise<void> {
  try {
    await loadStore();
    const server = createMemoryMcpServerFromEnv(options);
    await server.connect(new StdioServerTransport());
  } catch (err) {
    if (err instanceof MemoryMcpCallerEnvError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}
