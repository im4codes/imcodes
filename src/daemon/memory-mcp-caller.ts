import type { ContextNamespace } from '../../shared/context-types.js';
import { MEMORY_MCP_ENV_KEYS, type MemoryMcpEnvSource } from '../../shared/memory-mcp-env.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import { isValidImcodesSessionName } from '../../shared/session-scope.js';
import { createMemoryToolCaller, getBoundMemoryToolUserId, type MemoryToolCaller } from '../context/memory-read-tools.js';

export type MemoryMcpTransport = 'stdio' | 'in_process';

export interface McpRuntimeCaller {
  userId: string;
  namespace: ContextNamespace;
  sessionName: string | null;
  projectName: string | null;
  projectRoot: string | null;
  serverId: string | null;
  transport: MemoryMcpTransport;
}

export class MemoryMcpCallerEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryMcpCallerEnvError';
  }
}

const REQUIRED_ENV_ERROR = '[memory-mcp] fail-fast: IMCODES_DAEMON_{USER_ID,NAMESPACE} required';

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

export function parseMcpRuntimeCallerFromEnv(
  env: MemoryMcpEnvSource = process.env,
  transport: MemoryMcpTransport = 'stdio',
): McpRuntimeCaller {
  const userId = optionalString(env[MEMORY_MCP_ENV_KEYS.USER_ID]);
  const namespaceJson = optionalString(env[MEMORY_MCP_ENV_KEYS.NAMESPACE]);
  if (!userId || !namespaceJson) {
    throw new MemoryMcpCallerEnvError(REQUIRED_ENV_ERROR);
  }
  const namespace = parseNamespace(namespaceJson);
  if (namespace.userId && namespace.userId !== userId) {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: runtime user does not match namespace user');
  }
  const sessionName = optionalString(env[MEMORY_MCP_ENV_KEYS.SESSION_NAME]);
  if (sessionName && !isValidImcodesSessionName(sessionName)) {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: IMCODES_DAEMON_SESSION_NAME is invalid');
  }
  return Object.freeze({
    userId,
    namespace,
    sessionName,
    projectName: optionalString(env[MEMORY_MCP_ENV_KEYS.PROJECT_NAME]),
    projectRoot: optionalString(env[MEMORY_MCP_ENV_KEYS.PROJECT_ROOT]),
    serverId: optionalString(env[MEMORY_MCP_ENV_KEYS.SERVER_ID]),
    transport,
  });
}

export function assertMcpRuntimeBoundUser(caller: McpRuntimeCaller): void {
  const boundUserId = getBoundMemoryToolUserId();
  if (!boundUserId) {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: raw memory tools require a bound IM.codes user');
  }
  if (boundUserId !== caller.userId) {
    throw new MemoryMcpCallerEnvError('[memory-mcp] fail-fast: runtime user does not match bound IM.codes user');
  }
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
