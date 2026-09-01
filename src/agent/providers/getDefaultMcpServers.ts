import type { SessionConfig } from '../transport-provider.js';
import { IMCODES_SESSION_ENV } from '../../../shared/imcodes-send.js';
import {
  buildMemoryMcpServerEnv,
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
  IMCODES_DAEMON_PROVIDER_ID_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
  IMCODES_MCP_TOOL_CATALOG_MODE_ENV,
} from '../../../shared/memory-mcp-env.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import {
  MCP_TOOL_CATALOG_MODES,
  type McpToolCatalogMode,
} from '../../../shared/mcp-tool-discovery.js';
import {
  LEGACY_DAEMON_LOCAL_USER_ID,
  normalizeDaemonLocalMemoryNamespace,
} from '../../../shared/memory-namespace.js';

export const IMCODES_MEMORY_MCP_COMMAND = 'imcodes';
export const IMCODES_MEMORY_MCP_ARGS = ['memory', 'mcp'] as const;
// Was a local copy of the sentinel that shared/memory-namespace.ts already
// exports. Four such copies existed, which is how the two halves of the
// register/resolve invariant came to disagree in the first place.
const DAEMON_LOCAL_MEMORY_USER_ID = LEGACY_DAEMON_LOCAL_USER_ID;

export interface DefaultMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DefaultMcpServerOptions {
  /**
   * Managed providers default to a complete initial standard tools/list. A
   * provider may opt into dynamic publication only when its client owns a
   * proven tools/list_changed -> complete paginated tools/list refresh loop.
   */
  toolCatalogMode?: McpToolCatalogMode;
}

export interface AcpMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function projectNameFromSessionName(sessionName: string | undefined): string | undefined {
  if (!sessionName?.startsWith('deck_')) return undefined;
  const rest = sessionName.slice('deck_'.length);
  if (rest.startsWith('sub_')) return undefined;
  const idx = rest.lastIndexOf('_');
  if (idx <= 0) return undefined;
  return rest.slice(0, idx) || undefined;
}

/**
 * The namespace this MCP server RESOLVES memory handles under. Shares one helper
 * with handle registration (see normalizeDaemonLocalMemoryNamespace): when only
 * this side filled in the daemon-local owner, every injected handle was registered
 * under a different namespace and redeemed to nothing.
 */
function namespaceForMcp(config: SessionConfig): SessionConfig['contextNamespace'] {
  const namespace = config.contextNamespace ?? undefined;
  if (!namespace) return undefined;
  return normalizeDaemonLocalMemoryNamespace(namespace);
}

function buildIdentityEnv(config: SessionConfig): Record<string, string> {
  const namespace = namespaceForMcp(config);
  const sessionName = stringValue(config.sessionName)
    ?? stringValue(config.env?.[IMCODES_SESSION_ENV])
    ?? stringValue(config.bindExistingKey)
    ?? stringValue(config.sessionKey);
  return buildMemoryMcpServerEnv({
    [IMCODES_DAEMON_USER_ID_ENV]: namespace?.userId ?? DAEMON_LOCAL_MEMORY_USER_ID,
    [IMCODES_DAEMON_NAMESPACE_ENV]: namespace ? JSON.stringify(namespace) : undefined,
    [IMCODES_DAEMON_SESSION_NAME_ENV]: sessionName,
    [IMCODES_DAEMON_PROJECT_NAME_ENV]: stringValue(config.projectName) ?? projectNameFromSessionName(sessionName),
    [IMCODES_DAEMON_PROJECT_ROOT_ENV]: stringValue(config.cwd),
    [IMCODES_DAEMON_SERVER_ID_ENV]: stringValue(config.serverId),
    [IMCODES_DAEMON_PROVIDER_ID_ENV]: stringValue(config.providerId),
  });
}

export function getDefaultMcpServers(
  config: SessionConfig,
  options: DefaultMcpServerOptions = {},
): Record<string, DefaultMcpServerConfig> {
  const toolCatalogMode = options.toolCatalogMode ?? MCP_TOOL_CATALOG_MODES.STATIC_FULL;
  return {
    [IMCODES_MEMORY_MCP_SERVER_NAME]: {
      type: 'stdio',
      command: IMCODES_MEMORY_MCP_COMMAND,
      args: [...IMCODES_MEMORY_MCP_ARGS],
      env: {
        ...buildIdentityEnv(config),
        [IMCODES_MCP_TOOL_CATALOG_MODE_ENV]: toolCatalogMode,
      },
    },
  };
}

export function getDefaultAcpMcpServers(
  config: SessionConfig,
  options: DefaultMcpServerOptions = {},
): AcpMcpServerConfig[] {
  const server = getDefaultMcpServers(config, options)[IMCODES_MEMORY_MCP_SERVER_NAME];
  return [{
    name: IMCODES_MEMORY_MCP_SERVER_NAME,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }];
}
