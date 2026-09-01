import { IMCODES_MEMORY_MCP_ARGS, IMCODES_MEMORY_MCP_COMMAND } from './getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { IMCODES_MCP_TOOL_CATALOG_MODE_ENV } from '../../../shared/memory-mcp-env.js';
import { MCP_TOOL_CATALOG_MODES } from '../../../shared/mcp-tool-discovery.js';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

export function getDefaultCodexMcpArgs(): string[] {
  const prefix = `mcp_servers.${IMCODES_MEMORY_MCP_SERVER_NAME}`;
  return [
    '-c',
    `${prefix}.command=${tomlString(IMCODES_MEMORY_MCP_COMMAND)}`,
    '-c',
    `${prefix}.args=${tomlStringArray(IMCODES_MEMORY_MCP_ARGS)}`,
    '-c',
    `${prefix}.env.${IMCODES_MCP_TOOL_CATALOG_MODE_ENV}=${tomlString(MCP_TOOL_CATALOG_MODES.STATIC_FULL)}`,
  ];
}
