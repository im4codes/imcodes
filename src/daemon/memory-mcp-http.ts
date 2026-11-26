import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { LEGACY_DAEMON_LOCAL_USER_ID, normalizeDaemonLocalMemoryNamespace } from '../../shared/memory-namespace.js';
import { isMemoryScope, validateMemoryScopeIdentity } from '../../shared/memory-scope.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { resolveTaskPairTitleTurn } from './task-pair-title-authority.js';
import {
  MEMORY_MCP_DAEMON_RPC_MAX_BODY_BYTES,
  type MemoryMcpDaemonToolName,
} from '../../shared/memory-mcp-daemon-rpc.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MCP_TOOL_CATALOG_MODES, parseMcpToolCatalogMode } from '../../shared/mcp-tool-discovery.js';
import { getAuthenticatedCapabilityOwner } from '../capability/capability-authorization.js';
import { getSession, type SessionRecord } from '../store/session-store.js';
import { createMemoryMcpServer, mergeDefaultToolDeps } from './memory-mcp-server.js';
import type { McpRuntimeCaller, MemoryMcpTransport } from './memory-mcp-caller.js';
import {
  AMBIGUOUS_PARTICIPANT_ACTOR,
  readSenderParticipantTurn,
  type SenderParticipantTurn,
} from './sender-participant-turn.js';
import type { SessionResourceOwner } from './session-resource-registry.js';
import { createSupervisionMcpToolDeps } from './supervision-registry-port.js';
import { MEMORY_MCP_HTTP_HEADERS, MEMORY_MCP_HTTP_PATH } from './hook-server-state.js';

export { MEMORY_MCP_HTTP_HEADERS, MEMORY_MCP_HTTP_PATH };

const DEFAULT_HTTP_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_HTTP_SESSION_SWEEP_INTERVAL_MS = 60_000;

export type MemoryMcpToolInvoker = (
  caller: McpRuntimeCaller,
  tool: MemoryMcpDaemonToolName,
  input?: unknown,
) => Promise<Record<string, unknown>>;

export interface MemoryMcpHttpHandlerOptions {
  port: () => number;
  memoryMcpServerId?: string;
  invokeMemoryMcpTool: MemoryMcpToolInvoker;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

export interface MemoryMcpHttpHandler {
  handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  closeAll: () => Promise<void>;
  getSessionCount: () => number;
}

interface HttpMcpSessionEntry {
  sessionId: string;
  sessionName: string;
  sessionInstanceId?: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActiveAt: number;
  closed: boolean;
}

const PARTICIPANT_SCOPED_MEMORY_TOOLS = new Set<MemoryMcpDaemonToolName>([
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

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() || undefined;
  return typeof raw === 'string' ? (raw.trim() || undefined) : undefined;
}

function writeJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        settled = true;
        req.resume();
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function isInitializePayload(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some(
    (item) => Boolean(item && typeof item === 'object' && (item as { method?: unknown }).method === 'initialize'),
  );
}

/**
 * In-daemon Streamable HTTP `/mcp` handler shared across Codex threads.
 * Each logical Codex thread keeps a stateful `StreamableHTTPServerTransport` +
 * `McpServer` pair in the daemon process with zero child processes spawned.
 */
export function createMemoryMcpHttpHandler(options: MemoryMcpHttpHandlerOptions): MemoryMcpHttpHandler {
  const entries = new Map<string, HttpMcpSessionEntry>();
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_HTTP_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? Math.min(DEFAULT_HTTP_SESSION_SWEEP_INTERVAL_MS, idleTtlMs);
  const now = options.now ?? Date.now;
  let closingAll = false;

  const closeEntry = async (entry: HttpMcpSessionEntry): Promise<void> => {
    if (entry.closed) return;
    entry.closed = true;
    if (entries.get(entry.sessionId) === entry) {
      entries.delete(entry.sessionId);
    }
    await Promise.allSettled([
      entry.transport.close(),
      entry.server.close(),
    ]);
  };

  const sweepTimer = setInterval(() => {
    const cutoff = now() - idleTtlMs;
    for (const entry of [...entries.values()]) {
      if (entry.lastActiveAt <= cutoff) {
        void closeEntry(entry);
      }
    }
  }, Math.max(10, sweepIntervalMs));
  sweepTimer.unref?.();

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (closingAll) {
      writeJson(res, 503, { ok: false, error: 'memory_mcp_http_shutting_down' });
      return;
    }

    const sessionName = headerValue(req.headers, MEMORY_MCP_HTTP_HEADERS.SESSION);
    const session = sessionName ? getSession(sessionName) : null;
    if (!session || session.state === 'stopped' || session.incognito === true) {
      writeJson(res, 403, { ok: false, error: 'memory_mcp_http_identity_unavailable' });
      return;
    }

    const headerInstanceId = headerValue(req.headers, MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID);
    if (headerInstanceId && session.sessionInstanceId && headerInstanceId !== session.sessionInstanceId) {
      writeJson(res, 409, { ok: false, error: 'memory_mcp_http_stale_runtime' });
      return;
    }

    const mcpSessionId = headerValue(req.headers, 'mcp-session-id');
    if (mcpSessionId) {
      const entry = entries.get(mcpSessionId);
      if (!entry) {
        writeJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }
      if (entry.sessionName !== session.name) {
        writeJson(res, 403, { ok: false, error: 'memory_mcp_http_session_mismatch' });
        return;
      }
      if (entry.sessionInstanceId && session.sessionInstanceId && entry.sessionInstanceId !== session.sessionInstanceId) {
        await closeEntry(entry);
        writeJson(res, 409, { ok: false, error: 'memory_mcp_http_stale_runtime' });
        return;
      }
      entry.lastActiveAt = now();
      await entry.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
        id: null,
      });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req, MEMORY_MCP_DAEMON_RPC_MAX_BODY_BYTES);
    } catch (error) {
      const status = (error as { status?: number }).status === 413 ? 413 : 400;
      writeJson(res, status, {
        jsonrpc: '2.0',
        error: { code: status === 413 ? -32000 : -32700, message: status === 413 ? 'Request body too large' : 'Parse error: Invalid JSON' },
        id: null,
      });
      return;
    }

    if (!isInitializePayload(parsedBody)) {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: Server not initialized' },
        id: null,
      });
      return;
    }

    const requestedServerId = headerValue(req.headers, MEMORY_MCP_HTTP_HEADERS.SERVER_ID);
    const callerCtx = resolveSessionMcpCallerContext({
      session,
      requestedServerId,
      daemonServerId: options.memoryMcpServerId,
      transport: 'streamable_http',
    });
    if (!callerCtx.ok) {
      writeJson(res, callerCtx.status, { ok: false, error: callerCtx.error });
      return;
    }

    const boundSessionName = session.name;
    const boundRequestedServerId = requestedServerId;
    const resourceOwner: SessionResourceOwner | null = session.sessionInstanceId && session.runtimeEpoch
      ? {
          sessionName: session.name,
          sessionInstanceId: session.sessionInstanceId,
          runtimeEpoch: session.runtimeEpoch,
        }
      : null;

    const toolCatalogMode = parseMcpToolCatalogMode(
      headerValue(req.headers, MEMORY_MCP_HTTP_HEADERS.TOOL_CATALOG_MODE) ?? MCP_TOOL_CATALOG_MODES.STATIC_FULL,
    );

    let entry: HttpMcpSessionEntry | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        if (!entry) return;
        entry.sessionId = sessionId;
        entries.set(sessionId, entry);
      },
      onsessionclosed: () => {
        if (entry) void closeEntry(entry);
      },
    });

    const invokeInProcess = async (toolName: MemoryMcpDaemonToolName, input?: unknown): Promise<Record<string, unknown>> => {
      const current = getSession(boundSessionName);
      if (!current || current.state === 'stopped' || current.incognito === true) {
        throw new Error('daemon_memory_worker_identity_unavailable');
      }
      const latestCtx = resolveSessionMcpCallerContext({
        session: current,
        requestedServerId: boundRequestedServerId,
        daemonServerId: options.memoryMcpServerId,
        transport: 'streamable_http',
      });
      if (!latestCtx.ok) throw new Error(latestCtx.error);
      const participantTurn = readSenderParticipantTurn(current.name);
      if (toolName === MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE && participantTurn) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
          message: 'personal preference tools are not available during a shared-session participant turn',
        };
      }
      const scopedCaller = scopeMemoryCallerForParticipantTurn(latestCtx.caller, participantTurn, toolName);
      return options.invokeMemoryMcpTool(scopedCaller, toolName, input);
    };

    const hookPort = options.port();
    const deps = mergeDefaultToolDeps(
      callerCtx.caller,
      {
        invokeDaemonMemoryTool: invokeInProcess,
        participantTurnRequired: async () => Boolean(readSenderParticipantTurn(boundSessionName)),
        pairTitleTurn: () => resolveTaskPairTitleTurn({
          sessionName: boundSessionName,
          postAuthorityHook: async () => ({
            participantTurn: Boolean(readSenderParticipantTurn(boundSessionName)),
          }),
        }),
      },
      resourceOwner,
      {
        resolveHookPort: async () => options.port() || hookPort,
        resolveHookAuthority: async () => ({
          ok: true,
          port: options.port() || hookPort,
          owner: null,
        }),
      },
    );

    const server = createMemoryMcpServer(
      callerCtx.caller,
      deps,
      undefined,
      createSupervisionMcpToolDeps(),
      { toolCatalogMode },
    );

    entry = {
      sessionId: '',
      sessionName: boundSessionName,
      sessionInstanceId: session.sessionInstanceId,
      server,
      transport,
      lastActiveAt: now(),
      closed: false,
    };

    transport.onclose = () => {
      if (entry) void closeEntry(entry);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (entry) await closeEntry(entry);
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
      }
    }
  };

  const closeAll = async (): Promise<void> => {
    if (closingAll) return;
    closingAll = true;
    clearInterval(sweepTimer);
    await Promise.allSettled([...entries.values()].map((entry) => closeEntry(entry)));
    entries.clear();
  };

  return {
    handleRequest,
    closeAll,
    getSessionCount: () => entries.size,
  };
}
