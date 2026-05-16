import type { SessionConfig } from '../transport-provider.js';
import { IMCODES_SESSION_ENV } from '../../../shared/imcodes-send.js';
import {
  buildMemoryMcpServerEnv,
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
} from '../../../shared/memory-mcp-env.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';

export const IMCODES_MEMORY_MCP_COMMAND = 'imcodes';
export const IMCODES_MEMORY_MCP_ARGS = ['memory', 'mcp'] as const;
const DAEMON_LOCAL_MEMORY_USER_ID = 'daemon-local';

export interface DefaultMcpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
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

function namespaceForMcp(config: SessionConfig): SessionConfig['contextNamespace'] {
  const namespace = config.contextNamespace ?? undefined;
  if (!namespace) return undefined;
  if (namespace.userId?.trim()) return namespace;
  if (namespace.scope === 'personal' || namespace.scope === 'user_private') {
    return { ...namespace, userId: DAEMON_LOCAL_MEMORY_USER_ID };
  }
  return namespace;
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
  });
}

export function getDefaultMcpServers(config: SessionConfig): Record<string, DefaultMcpServerConfig> {
  return {
    [IMCODES_MEMORY_MCP_SERVER_NAME]: {
      type: 'stdio',
      command: IMCODES_MEMORY_MCP_COMMAND,
      args: [...IMCODES_MEMORY_MCP_ARGS],
      env: buildIdentityEnv(config),
    },
  };
}

export function getDefaultAcpMcpServers(config: SessionConfig): AcpMcpServerConfig[] {
  const server = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME];
  return [{
    name: IMCODES_MEMORY_MCP_SERVER_NAME,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  }];
}
