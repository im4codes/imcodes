#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Keep the memory MCP launch path independent from the daemon CLI graph.
 *
 * This dispatch intentionally happens before importing commander, the daemon,
 * the agent providers, or the SQLite-backed memory implementation.  Under
 * filesystem/CPU pressure that graph has taken more than 20 seconds merely to
 * evaluate, exhausting MCP clients' 30 second connection budget before the
 * server could answer initialize.
 */
const isMemoryMcp = process.argv[2] === 'memory'
  && process.argv[3] === 'mcp'
  && process.argv.length === 4;
const entry = process.argv[1];
const isMain = Boolean(entry) && (() => {
  try {
    return realpathSync(entry!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry!) === fileURLToPath(import.meta.url);
  }
})();

if (isMain && isMemoryMcp) {
  const { IMCODES_MEMORY_MCP_BACKEND_ENV } = await import('./daemon/mcp-stdio-lifecycle.js');
  if (process.env[IMCODES_MEMORY_MCP_BACKEND_ENV] === '1') {
    const { runMemoryMcpServer } = await import('./daemon/memory-mcp-server.js');
    await runMemoryMcpServer();
  } else {
    const { runMemoryMcpBootstrap } = await import('./daemon/memory-mcp-bootstrap.js');
    await runMemoryMcpBootstrap();
  }
} else if (isMain) {
  const { runCli } = await import('./cli.js');
  runCli();
}
