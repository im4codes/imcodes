import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import {
  MemoryMcpCallerEnvError,
  parseMcpRuntimeCallerFromEnv,
  type McpRuntimeCaller,
} from './memory-mcp-caller.js';
import { registerMemoryMcpTools, type MemoryMcpToolDeps } from './memory-mcp-tools.js';

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

export function createMemoryMcpServerFromEnv(options: MemoryMcpServerOptions = {}): McpServer {
  const caller = parseMcpRuntimeCallerFromEnv(options.env ?? process.env, 'stdio');
  return createMemoryMcpServer(caller, options.toolDeps);
}

export async function runMemoryMcpServer(options: MemoryMcpServerOptions = {}): Promise<void> {
  try {
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
