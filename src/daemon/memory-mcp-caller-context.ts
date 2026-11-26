import type { ContextNamespace } from '../../shared/context-types.js';
import { LEGACY_DAEMON_LOCAL_USER_ID, normalizeDaemonLocalMemoryNamespace } from '../../shared/memory-namespace.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import type { MemoryMcpDaemonToolName } from '../../shared/memory-mcp-daemon-rpc.js';
import { getAuthenticatedCapabilityOwner } from '../capability/capability-authorization.js';
import type { SessionRecord } from '../store/session-store.js';
import type { McpRuntimeCaller, MemoryMcpTransport } from './memory-mcp-caller.js';
import { AMBIGUOUS_PARTICIPANT_ACTOR, type SenderParticipantTurn } from './sender-participant-turn.js';

export const PARTICIPANT_SCOPED_MEMORY_TOOLS = new Set<MemoryMcpDaemonToolName>([
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
]);

export function validCapabilityNamespace(value: unknown): value is ContextNamespace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const namespace = value as ContextNamespace;
  if (!isMemoryScope(namespace.scope)) return false;
  return validateMemoryScopeIdentity(namespace.scope, {
    user_id: namespace.userId,
    project_id: namespace.projectId,
    workspace_id: namespace.workspaceId,
    org_id: namespace.enterpriseId,
    tenant_id: namespace.localTenant,
  }).ok;
}

export function scopeMemoryCallerForParticipantTurn(
  baseCaller: McpRuntimeCaller,
  participantTurn: SenderParticipantTurn | boolean | null,
  tool: MemoryMcpDaemonToolName,
): McpRuntimeCaller {
  if (!participantTurn || !PARTICIPANT_SCOPED_MEMORY_TOOLS.has(tool)) {
    return baseCaller;
  }
  const actorUserId = typeof participantTurn === 'object'
    && participantTurn !== null
    && typeof participantTurn.actorUserId === 'string'
    && participantTurn.actorUserId.trim()
    ? participantTurn.actorUserId.trim()
    : AMBIGUOUS_PARTICIPANT_ACTOR;
  const participantAuthority = typeof participantTurn === 'object'
    && participantTurn !== null
    && typeof participantTurn.authority === 'string'
    && participantTurn.authority.trim()
    ? participantTurn.authority.trim()
    : null;
  return Object.freeze({
    ...baseCaller,
    userId: actorUserId,
    namespace: {
      ...baseCaller.namespace,
      userId: actorUserId,
    },
    isParticipantTurn: true,
    participantAuthority,
  });
}

/**
 * Resolve an authoritative `McpRuntimeCaller` from a live `SessionRecord` and
 * optional server identity claim, failing closed if the server identity belongs
 * to another user. Shared between `/memory-mcp/tool` and `/mcp`.
 */
export function resolveSessionMcpCallerContext(params: {
  session: SessionRecord;
  requestedServerId?: string;
  daemonServerId?: string;
  transport: MemoryMcpTransport;
  fallbackToDaemonServerId?: boolean;
}): { ok: true; caller: McpRuntimeCaller } | { ok: false; status: 403; error: string } {
  const { session, transport } = params;
  const requestedServerId = params.requestedServerId?.trim() ?? '';
  const authenticatedOwner = requestedServerId
    ? getAuthenticatedCapabilityOwner(requestedServerId)
    : undefined;
  const daemonServerId = params.daemonServerId?.trim() ?? '';
  const normalizedStoredNamespace = session.contextNamespace
    ? normalizeDaemonLocalMemoryNamespace(session.contextNamespace)
    : null;
  const storedNamespace = validCapabilityNamespace(normalizedStoredNamespace)
    ? normalizedStoredNamespace
    : { scope: 'user_private' as const, userId: LEGACY_DAEMON_LOCAL_USER_ID };
  const storedUserId = storedNamespace.userId?.trim() || LEGACY_DAEMON_LOCAL_USER_ID;
  const isDaemonBoundLegacyNamespace = storedUserId === LEGACY_DAEMON_LOCAL_USER_ID
    && Boolean(daemonServerId)
    && requestedServerId === daemonServerId;
  if (requestedServerId
    && authenticatedOwner !== storedUserId
    && !isDaemonBoundLegacyNamespace) {
    return { ok: false, status: 403, error: 'daemon_memory_worker_server_identity_unavailable' };
  }
  const effectiveServerId = requestedServerId || (params.fallbackToDaemonServerId === false ? null : daemonServerId || null);
  return {
    ok: true,
    caller: Object.freeze({
      userId: storedUserId,
      namespace: storedNamespace,
      sessionName: session.name,
      projectName: session.projectName,
      projectRoot: session.projectDir,
      serverId: effectiveServerId,
      providerId: session.providerId ?? session.agentType,
      transport,
    }),
  };
}
