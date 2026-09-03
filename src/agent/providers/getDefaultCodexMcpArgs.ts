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

/**
 * Full argv for the IM.codes-managed Codex app-server.
 *
 * Native multi-agent collaboration is disabled at PROCESS START. This is the
 * only pre-execution capability removal the current CLI supports: thread-level
 * `multiAgentMode` is deprecated/ignored and `collaborationMode` only selects
 * instruction presets, so neither can veto a call. `handleRawResponseItem` sees
 * an item only AFTER the tool ran, so it cannot gate either. Verified against
 * codex-cli 0.152.1: `codex features list` reports multi_agent stable=true, and
 * `--disable multi_agent` flips it to false so a turn asked to call spawn_agent
 * returns NATIVE_COLLAB_UNAVAILABLE with no collaboration item emitted at all.
 *
 * This is deliberately process-wide for the provider, not Brain-only: native
 * ephemeral collaboration is sacrificed so user delegation cannot bypass
 * IM.codes authority. The MCP catalog stays static_full, so IM send_message and
 * the supervision tools are unaffected.
 */
export const CODEX_DISABLED_FEATURES = ['multi_agent'] as const;

export function getCodexAppServerArgs(): string[] {
  const disable = CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]);
  return [...getDefaultCodexMcpArgs(), ...disable, 'app-server'];
}
