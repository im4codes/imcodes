import type { SessionConfig } from '../transport-provider.js';
import { IMCODES_MCP_PARENT_PID_ENV } from '../../daemon/mcp-stdio-lifecycle.js';
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
import { SESSION_RESOURCE_OWNER_ENV } from '../../../shared/session-resource-lifecycle.js';
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

/**
 * The shape every real MCP launch actually uses.
 *
 * The memory server guards against being orphaned by comparing its parent
 * against the one it observed at startup. That cannot see a parent which died
 * before the server's first instruction: the very first `process.ppid` it
 * reads is already the reparent target, so every later read matches it and the
 * guard can never fire. Only the spawner can settle that, by declaring who it
 * is -- so on POSIX the launch is an exec-preserving shell that captures its
 * own parent (the MCP client) and then BECOMES the server:
 *
 *   sh -c 'IMCODES_MCP_PARENT_PID=$PPID exec "$0" "$@"' imcodes memory mcp
 *
 * `exec` matters: no shell survives, so stdio, exit status and signal delivery
 * stay exactly as they were without a wrapper.
 *
 * This NARROWS the undeclared window from "the server's own module evaluation"
 * (Node boot, tens of milliseconds) to "before the wrapper shell starts"
 * (about a millisecond). It does not CLOSE it, and no userspace wrapper can:
 * a wrapper stopped before it reads `$PPID` observes the reparent target too.
 * Closing it needs an OS parent-death primitive -- `prctl(PR_SET_PDEATHSIG)`,
 * kqueue `NOTE_EXIT`, a Windows Job Object -- none reachable from plain Node.
 *
 * Windows keeps the direct launch: it has no `exec`, so any wrapper there
 * would leave an intermediate process between the client and the server and
 * break signal/exit-code fidelity. It therefore keeps the module-evaluation
 * snapshot only, and is not narrowed.
 */
export const IMCODES_MEMORY_MCP_LAUNCH_COMMAND = process.platform === 'win32'
  ? IMCODES_MEMORY_MCP_COMMAND
  : 'sh';

export const IMCODES_MEMORY_MCP_LAUNCH_ARGS: readonly string[] = process.platform === 'win32'
  ? [...IMCODES_MEMORY_MCP_ARGS]
  : [
    '-c',
    `${IMCODES_MCP_PARENT_PID_ENV}=$PPID exec "$0" "$@"`,
    IMCODES_MEMORY_MCP_COMMAND,
    ...IMCODES_MEMORY_MCP_ARGS,
  ];

/**
 * True for an entry this daemon owns, in either the direct or wrapped shape.
 *
 * Configs written before the wrapper existed still name the bare command, and
 * must keep being recognised -- otherwise the writer would stop seeing its own
 * entry and append a duplicate beside it.
 */
export function isImcodesMemoryMcpLaunch(command: unknown, args: unknown): boolean {
  if (typeof command !== 'string' || !Array.isArray(args)) return false;
  const matches = (expectedCommand: string, expectedArgs: readonly string[]): boolean => (
    command === expectedCommand
    && args.length === expectedArgs.length
    && args.every((arg, index) => arg === expectedArgs[index])
  );
  return matches(IMCODES_MEMORY_MCP_LAUNCH_COMMAND, IMCODES_MEMORY_MCP_LAUNCH_ARGS)
    || matches(IMCODES_MEMORY_MCP_COMMAND, IMCODES_MEMORY_MCP_ARGS);
}
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
    [SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]: stringValue(config.sessionInstanceId),
    [SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]: stringValue(config.runtimeEpoch),
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
      command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
      args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
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
