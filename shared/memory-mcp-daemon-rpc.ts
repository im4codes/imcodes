import { MEMORY_MCP_TOOL_NAMES, type MemoryMcpToolName } from './memory-mcp-contracts.js';

/** Local daemon ingress used by stdio MCP adapters for memory operations. */
export const MEMORY_MCP_DAEMON_RPC_PATH = '/memory-mcp/tool';

/** Memory writes are capped at 16 KiB; leave bounded room for identity/envelope data. */
export const MEMORY_MCP_DAEMON_RPC_MAX_BODY_BYTES = 64 * 1024;

/**
 * Tools whose implementation owns local context-store or embedding work.
 * Stdio MCP processes proxy this exact set to the daemon so all sessions share
 * the daemon's single context-store worker and embedding worker.
 */
export const MEMORY_MCP_DAEMON_TOOL_NAMES = [
  MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
  MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
  MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
  MEMORY_MCP_TOOL_NAMES.ARCHIVE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.RESTORE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.DELETE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.UPDATE_MEMORY,
  MEMORY_MCP_TOOL_NAMES.MEMORY_FEEDBACK,
  MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
  MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
] as const satisfies readonly MemoryMcpToolName[];

export type MemoryMcpDaemonToolName = typeof MEMORY_MCP_DAEMON_TOOL_NAMES[number];

const MEMORY_MCP_DAEMON_TOOL_NAME_SET: ReadonlySet<string> = new Set(MEMORY_MCP_DAEMON_TOOL_NAMES);

export function isMemoryMcpDaemonToolName(value: unknown): value is MemoryMcpDaemonToolName {
  return typeof value === 'string' && MEMORY_MCP_DAEMON_TOOL_NAME_SET.has(value);
}
