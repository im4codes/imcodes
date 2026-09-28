import type { ContextNamespace } from '../../shared/context-types.js';
import { LEGACY_DAEMON_LOCAL_USER_ID } from '../../shared/memory-namespace.js';
import { MEMORY_MCP_ENV_KEYS, type MemoryMcpEnvSource } from '../../shared/memory-mcp-env.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import { isValidImcodesSessionName } from '../../shared/session-scope.js';
import { createMemoryToolCaller, type MemoryToolCaller } from '../context/memory-read-tools.js';

export type MemoryMcpTransport = 'stdio' | 'in_process';

export interface McpRuntimeCaller {
  userId: string;
  namespace: ContextNamespace;
  sessionName: string | null;
  projectName: string | null;
  projectRoot: string | null;
  serverId: string | null;
  providerId: string | null;
  transport: MemoryMcpTransport;
}

export class MemoryMcpCallerEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryMcpCallerEnvError';
  }
}

// Alias of the shared sentinel rather than a fourth copy of the literal.
const DAEMON_LOCAL_MEMORY_USER_ID = LEGACY_DAEMON_LOCAL_USER_ID;

function optionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseNamespace(raw: string): ContextNamespace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: IMCODES_DAEMON_NAMESPACE must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: IMCODES_DAEMON_NAMESPACE must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (!isMemoryScope(record.scope)) {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: IMCODES_DAEMON_NAMESPACE has an invalid scope');
  }
  const namespace: ContextNamespace = {
    scope: record.scope,
    projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
    userId: typeof record.userId === 'string' ? record.userId : undefined,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : undefined,
    enterpriseId: typeof record.enterpriseId === 'string' ? record.enterpriseId : undefined,
    localTenant: typeof record.localTenant === 'string' ? record.localTenant : undefined,
    canonicalRepoId: typeof record.canonicalRepoId === 'string' ? record.canonicalRepoId : undefined,
  };
  const identity = {
    user_id: namespace.userId,
    project_id: namespace.projectId,
    workspace_id: namespace.workspaceId,
    org_id: namespace.enterpriseId,
    tenant_id: namespace.localTenant,
  };
  const validation = validateMemoryScopeIdentity(namespace.scope, identity);
  if (!validation.ok) {
    throw new MemoryMcpCallerEnvError(`[memory-mcp] fail-fast: IMCODES_DAEMON_NAMESPACE invalid: ${validation.reason}`);
  }
  return namespace;
}

function localNamespace(userId = DAEMON_LOCAL_MEMORY_USER_ID): ContextNamespace {
  return { scope: 'user_private', userId };
}

function runtimeUserId(rawUserId: string | null, namespace: ContextNamespace): string {
  const namespaceUserId = optionalString(namespace.userId);
  return namespaceUserId ?? rawUserId ?? DAEMON_LOCAL_MEMORY_USER_ID;
}

// Some provider hosts (notably a long-lived Codex app-server) historically
// put their opaque provider session UUID in IMCODES_DAEMON_SESSION_NAME when
// the daemon could not inject the canonical deck_* name into a resumed MCP
// config.  It is not an IM.codes session and must never be used for routing,
// but rejecting it makes the bootstrap crash-loop forever after a daemon
// restart.  Treat only UUID-shaped values as this legacy provider identity;
// all other malformed names still fail closed.
const PROVIDER_HOST_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMcpRuntimeCallerFromEnv(
  env: MemoryMcpEnvSource = process.env,
  transport: MemoryMcpTransport = 'stdio',
): McpRuntimeCaller {
  const namespaceJson = optionalString(env[MEMORY_MCP_ENV_KEYS.NAMESPACE]);
  const envUserId = optionalString(env[MEMORY_MCP_ENV_KEYS.USER_ID]);
  const namespace = namespaceJson ? parseNamespace(namespaceJson) : localNamespace(envUserId ?? undefined);
  const userId = runtimeUserId(envUserId, namespace);
  const rawSessionName = optionalString(env[MEMORY_MCP_ENV_KEYS.SESSION_NAME]);
  if (rawSessionName && !isValidImcodesSessionName(rawSessionName) && !PROVIDER_HOST_SESSION_ID.test(rawSessionName)) {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: IMCODES_DAEMON_SESSION_NAME is invalid');
  }
  const sessionName = rawSessionName && isValidImcodesSessionName(rawSessionName) ? rawSessionName : null;
  return Object.freeze({
    userId,
    namespace,
    sessionName,
    projectName: optionalString(env[MEMORY_MCP_ENV_KEYS.PROJECT_NAME]),
    projectRoot: optionalString(env[MEMORY_MCP_ENV_KEYS.PROJECT_ROOT]),
    serverId: optionalString(env[MEMORY_MCP_ENV_KEYS.SERVER_ID]),
    providerId: optionalString(env[MEMORY_MCP_ENV_KEYS.PROVIDER_ID]),
    transport,
  });
}

export function deriveMemoryToolCaller(caller: McpRuntimeCaller): MemoryToolCaller {
  return createMemoryToolCaller({
    userId: caller.userId,
    namespace: caller.namespace,
    sessionName: caller.sessionName,
    projectName: caller.projectName,
    serverId: caller.serverId,
  });
}
