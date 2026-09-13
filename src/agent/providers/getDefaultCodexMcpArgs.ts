import { IMCODES_MEMORY_MCP_LAUNCH_ARGS, IMCODES_MEMORY_MCP_LAUNCH_COMMAND } from './getDefaultMcpServers.js';
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
    `${prefix}.command=${tomlString(IMCODES_MEMORY_MCP_LAUNCH_COMMAND)}`,
    '-c',
    `${prefix}.args=${tomlStringArray(IMCODES_MEMORY_MCP_LAUNCH_ARGS)}`,
    '-c',
    `${prefix}.env.${IMCODES_MCP_TOOL_CATALOG_MODE_ENV}=${tomlString(MCP_TOOL_CATALOG_MODES.STATIC_FULL)}`,
  ];
}

/**
 * Full argv for the IM.codes-managed Codex app-server.
 *
 * No process-wide feature flag here. The app-server is ONE process for every
 * session, so a flag could only remove native multi-agent from all sessions at
 * once, genuinely unmanaged ones included. The fence is per session instead:
 * `CodexSdkProvider.startNewThread` creates a managed session's thread with
 * `config.features.{multi_agent,multi_agent_v2}=false`, which Codex keeps for
 * that thread's whole life (verified against codex-cli 0.153: neither resume
 * config nor `--disable` process flags change an existing thread, and every
 * turn records `turn_context.multi_agent_version`). Supervised dispatch is
 * admitted only for a thread whose fence is proven
 * (src/daemon/native-agent-admission.ts). The MCP catalog stays static_full,
 * so IM send_message and the supervision tools remain the authoritative route.
 */
export function getCodexAppServerArgs(): string[] {
  return [...getDefaultCodexMcpArgs(), 'app-server'];
}
