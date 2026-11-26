import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  HOOK_SESSION_CREDENTIAL_ERROR,
  HOOK_SESSION_CREDENTIAL_HEADER,
} from '../../shared/hook-session-credential.js';
import { HOOK_AUTHORITY_ERROR } from '../../shared/hook-authority.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { resolveTaskPairTitleTurn } from './task-pair-title-authority.js';
import {
  MEMORY_MCP_DAEMON_RPC_MAX_BODY_BYTES,
  type MemoryMcpDaemonToolName,
} from '../../shared/memory-mcp-daemon-rpc.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MCP_TOOL_CATALOG_MODES, parseMcpToolCatalogMode } from '../../shared/mcp-tool-discovery.js';
import { getSession, type SessionRecord } from '../store/session-store.js';
import { createMemoryMcpServer, mergeDefaultToolDeps } from './memory-mcp-server.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import {
  resolveSessionMcpCallerContext,
  scopeMemoryCallerForParticipantTurn,
  validCapabilityNamespace,
} from './memory-mcp-caller-context.js';
import { sameHookCredential } from './hook-session-credential.js';
import { readSenderParticipantTurn } from './sender-participant-turn.js';
import type { SessionResourceOwner } from './session-resource-registry.js';
import { createSupervisionMcpToolDeps } from './supervision-registry-port.js';
import { MEMORY_MCP_HTTP_HEADERS, MEMORY_MCP_HTTP_PATH } from './hook-server-state.js';

export {
  MEMORY_MCP_HTTP_HEADERS,
  MEMORY_MCP_HTTP_PATH,
  resolveSessionMcpCallerContext,
  scopeMemoryCallerForParticipantTurn,
  validCapabilityNamespace,
};

const DEFAULT_HTTP_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_HTTP_SESSION_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_HTTP_SESSIONS = 1024;

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
  maxSessions?: number;
  now?: () => number;
}

export interface MemoryMcpHttpHandler {
  handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  /** Close active/pending HTTP MCP sessions for a listener rebind while keeping the handler reusable. */
  resetSessions: () => Promise<void>;
  /** Permanently shut down the handler, clearing the sweep timer and rejecting late registrations. */
  closeAll: () => Promise<void>;
  getSessionCount: () => number;
}

interface HttpMcpSessionEntry {
  sessionId: string;
  generation: number;
  sessionName: string;
  sessionInstanceId: string;
  hookCredential: string;
  server: McpServer | null;
  transport: StreamableHTTPServerTransport | null;
  lastActiveAt: number;
  activePostCount: number;
  closed: boolean;
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
  const pendingEntries = new Set<HttpMcpSessionEntry>();
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_HTTP_SESSION_IDLE_TTL_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? Math.min(DEFAULT_HTTP_SESSION_SWEEP_INTERVAL_MS, idleTtlMs);
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_HTTP_SESSIONS);
  const now = options.now ?? Date.now;
  let closingAll = false;
  let generation = 0;

  const closeEntry = async (entry: HttpMcpSessionEntry): Promise<void> => {
    if (entry.closed) return;
    entry.closed = true;
    pendingEntries.delete(entry);
    if (entry.sessionId && entries.get(entry.sessionId) === entry) {
      entries.delete(entry.sessionId);
    }
    await Promise.allSettled([
      entry.transport?.close(),
      entry.server?.close(),
    ]);
  };

  const reapIdleEntries = (): void => {
    const cutoff = now() - idleTtlMs;
    for (const entry of [...entries.values()]) {
      if (entry.activePostCount === 0 && entry.lastActiveAt <= cutoff) {
        void closeEntry(entry);
      }
    }
  };

  const sweepTimer = setInterval(reapIdleEntries, Math.max(10, sweepIntervalMs));
  sweepTimer.unref?.();

  const validateHttpSessionHeaders = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): { session: SessionRecord; hookCredential: string; sessionInstanceId: string } | null => {
    const sessionName = headerValue(req.headers, MEMORY_MCP_HTTP_HEADERS.SESSION);
    const session = sessionName ? getSession(sessionName) : null;
    if (!session || session.state === 'stopped' || session.incognito === true) {
      writeJson(res, 403, { ok: false, error: 'memory_mcp_http_identity_unavailable' });
      return null;
    }

    const expectedCredential = session.hookCredential?.trim();
    const presentedCredential = headerValue(req.headers, HOOK_SESSION_CREDENTIAL_HEADER);
    if (!expectedCredential || !presentedCredential || !sameHookCredential(expectedCredential, presentedCredential)) {
      writeJson(res, 403, { ok: false, error: HOOK_SESSION_CREDENTIAL_ERROR });
      return null;
    }

    const expectedInstanceId = session.sessionInstanceId?.trim();
    const presentedInstanceId = headerValue(req.headers, MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID);
    if (!expectedInstanceId || !presentedInstanceId) {
      writeJson(res, 403, { ok: false, error: 'memory_mcp_http_identity_unavailable' });
      return null;
    }
    if (presentedInstanceId !== expectedInstanceId) {
      writeJson(res, 409, { ok: false, error: 'memory_mcp_http_stale_runtime' });
      return null;
    }

    return {
      session,
      hookCredential: expectedCredential,
      sessionInstanceId: expectedInstanceId,
    };
  };

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (closingAll) {
      writeJson(res, 503, { ok: false, error: 'memory_mcp_http_shutting_down' });
      return;
    }

    const auth = validateHttpSessionHeaders(req, res);
    if (!auth) return;
    const { session, hookCredential, sessionInstanceId } = auth;

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
      if (!sameHookCredential(entry.hookCredential, hookCredential)) {
        await closeEntry(entry);
        writeJson(res, 403, { ok: false, error: HOOK_SESSION_CREDENTIAL_ERROR });
        return;
      }
      if (entry.sessionInstanceId !== sessionInstanceId) {
        await closeEntry(entry);
        writeJson(res, 409, { ok: false, error: 'memory_mcp_http_stale_runtime' });
        return;
      }
      if (!entry.transport) {
        writeJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }

      if (req.method === 'POST') {
        entry.activePostCount += 1;
        entry.lastActiveAt = now();
        try {
          await entry.transport.handleRequest(req, res);
        } finally {
          entry.activePostCount = Math.max(0, entry.activePostCount - 1);
          entry.lastActiveAt = now();
        }
        return;
      }

      // Long-lived GET SSE streams must not prevent idle session TTL eviction once inactive.
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

    if (entries.size + pendingEntries.size >= maxSessions) {
      reapIdleEntries();
    }
    if (entries.size + pendingEntries.size >= maxSessions) {
      writeJson(res, 503, { ok: false, error: 'memory_mcp_http_capacity_exceeded' });
      return;
    }

    const requestGeneration = generation;
    const entry: HttpMcpSessionEntry = {
      sessionId: '',
      generation: requestGeneration,
      sessionName: session.name,
      sessionInstanceId,
      hookCredential,
      server: null,
      transport: null,
      lastActiveAt: now(),
      activePostCount: 1,
      closed: false,
    };
    pendingEntries.add(entry);

    let settled = false;
    try {
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

      if (closingAll || entry.closed || requestGeneration !== generation) {
        writeJson(res, 503, { ok: false, error: 'memory_mcp_http_shutting_down' });
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
      const boundInstanceId = sessionInstanceId;
      const boundHookCredential = hookCredential;
      const boundRequestedServerId = requestedServerId;
      const verifyBoundConnection = (): SessionRecord | null => {
        if (entry.closed || closingAll) return null;
        const current = getSession(boundSessionName);
        if (
          !current
          || current.state === 'stopped'
          || current.incognito === true
          || current.sessionInstanceId?.trim() !== boundInstanceId
          || !current.hookCredential?.trim()
          || !sameHookCredential(current.hookCredential.trim(), boundHookCredential)
        ) {
          void closeEntry(entry);
          return null;
        }
        return current;
      };
      const resourceOwner: SessionResourceOwner | null = session.runtimeEpoch
        ? {
            sessionName: session.name,
            sessionInstanceId,
            runtimeEpoch: session.runtimeEpoch,
          }
        : null;

      const toolCatalogMode = parseMcpToolCatalogMode(
        headerValue(req.headers, MEMORY_MCP_HTTP_HEADERS.TOOL_CATALOG_MODE) ?? MCP_TOOL_CATALOG_MODES.STATIC_FULL,
      );

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          if (closingAll || entry.closed || requestGeneration !== generation) {
            void closeEntry(entry);
            return;
          }
          entry.sessionId = sessionId;
          pendingEntries.delete(entry);
          entries.set(sessionId, entry);
        },
        onsessionclosed: () => {
          void closeEntry(entry);
        },
      });

      const invokeInProcess = async (toolName: MemoryMcpDaemonToolName, input?: unknown): Promise<Record<string, unknown>> => {
        const current = verifyBoundConnection();
        if (!current) {
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
          participantTurnRequired: async () => {
            const current = verifyBoundConnection();
            if (!current) throw new Error('daemon_memory_worker_identity_unavailable');
            return Boolean(readSenderParticipantTurn(current.name));
          },
          pairTitleTurn: () => resolveTaskPairTitleTurn({
            sessionName: boundSessionName,
            postAuthorityHook: async () => {
              const current = verifyBoundConnection();
              if (!current) throw new Error('daemon_memory_worker_identity_unavailable');
              return {
                participantTurn: Boolean(readSenderParticipantTurn(current.name)),
              };
            },
          }),
        },
        resourceOwner,
        {
          hookCredential: () => {
            const current = verifyBoundConnection();
            if (!current) throw new Error('daemon_memory_worker_identity_unavailable');
            return boundHookCredential;
          },
          resolveHookPort: async () => {
            if (!verifyBoundConnection()) throw new Error('daemon_memory_worker_identity_unavailable');
            return options.port() || hookPort;
          },
          resolveHookAuthority: async () => {
            if (!verifyBoundConnection()) {
              return {
                ok: false,
                reason: HOOK_AUTHORITY_ERROR.hookUnavailable,
                detail: 'bound HTTP MCP session is no longer active',
              };
            }
            return {
              ok: true,
              port: options.port() || hookPort,
              owner: null,
            };
          },
        },
      );

      const server = createMemoryMcpServer(
        callerCtx.caller,
        deps,
        undefined,
        createSupervisionMcpToolDeps(),
        {
          toolCatalogMode,
          verifyDispatchIdentity: () => {
            if (!verifyBoundConnection()) {
              throw new Error('daemon_memory_worker_identity_unavailable');
            }
          },
        },
      );

      entry.server = server;
      entry.transport = transport;
      transport.onclose = () => {
        void closeEntry(entry);
      };

      await server.connect(transport);
      if (closingAll || entry.closed || requestGeneration !== generation) {
        await closeEntry(entry);
        writeJson(res, 503, { ok: false, error: 'memory_mcp_http_shutting_down' });
        return;
      }

      settled = true;
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      await closeEntry(entry);
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
      }
    } finally {
      pendingEntries.delete(entry);
      entry.activePostCount = Math.max(0, entry.activePostCount - 1);
      entry.lastActiveAt = now();
      if (!settled && !entry.sessionId) {
        await closeEntry(entry);
      }
    }
  };

  const resetSessions = async (): Promise<void> => {
    generation += 1;
    const toClose = [...pendingEntries, ...entries.values()];
    pendingEntries.clear();
    entries.clear();
    await Promise.allSettled(toClose.map((entry) => closeEntry(entry)));
  };

  const closeAll = async (): Promise<void> => {
    if (closingAll) return;
    closingAll = true;
    clearInterval(sweepTimer);
    await resetSessions();
  };

  return {
    handleRequest,
    resetSessions,
    closeAll,
    getSessionCount: () => entries.size,
  };
}
