import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import catalog from './memory-mcp-bootstrap-catalog.json' with { type: 'json' };
import {
  SESSION_RESOURCE_HANDLE_TYPE,
  SESSION_RESOURCE_KIND,
  SESSION_RESOURCE_OWNER_ENV,
  SESSION_RESOURCE_RELEASE_REASON,
} from '../../shared/session-resource-lifecycle.js';
import { SessionResourceRegistry, type SessionResourceOwner } from './session-resource-registry.js';
import {
  IMCODES_MCP_PARENT_PID_ENV,
  IMCODES_MEMORY_MCP_BACKEND_ENV,
  MCP_PROCESS_START_PARENT_PID,
  installMcpStdioLifecycle,
} from './mcp-stdio-lifecycle.js';

type JsonRpcId = string | number | null;
type JsonRpcMessage = Record<string, unknown> & { id?: JsonRpcId; method?: string };
type Tool = Record<string, unknown> & { name?: string };

interface BootstrapCatalog {
  version: number;
  dynamic: Tool[];
  static_full: Tool[];
}

const catalogs = catalog as BootstrapCatalog;
const BACKEND_START_TIMEOUT_MS = 60_000;
const QUEUED_REQUEST_TIMEOUT_MS = 30_000;
const IN_FLIGHT_REQUEST_TIMEOUT_MS = 30_000;
const TOOL_CALL_DEFAULT_TIMEOUT_MS = 15 * 60_000;
const TOOL_CALL_TIMEOUT_HEADROOM_MS = 60_000;
const TOOL_CALL_MAX_DECLARED_TIMEOUT_MS = 60 * 60_000;
const BACKEND_STABLE_UPTIME_MS = 30_000;
const MAX_QUEUED_REQUESTS = 64;
const RESTART_DELAYS_MS = [250, 1_000, 3_000, 5_000] as const;

interface QueuedMessage {
  message: JsonRpcMessage;
  timer: ReturnType<typeof setTimeout> | null;
}

interface InFlightRequest {
  id: JsonRpcId;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

function testOnlyDuration(name: string, fallback: number): number {
  if (process.env.NODE_ENV !== 'test') return fallback;
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function requestId(message: JsonRpcMessage): JsonRpcId | undefined {
  return Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined;
}

function requestedToolTimeoutMs(message: JsonRpcMessage): number | null {
  if (message.method !== 'tools/call') return null;
  const params = message.params;
  if (!params || typeof params !== 'object') return null;
  const args = (params as { arguments?: unknown }).arguments;
  if (!args || typeof args !== 'object') return null;
  const timeoutMs = (args as { timeoutMs?: unknown }).timeoutMs;
  return Number.isSafeInteger(timeoutMs) && (timeoutMs as number) > 0
    ? Math.min(timeoutMs as number, TOOL_CALL_MAX_DECLARED_TIMEOUT_MS)
    : null;
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function serverInfo(protocolVersion: unknown): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    result: {
      protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : '2024-11-05',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'imcodes-memory', version: '0.1.0' },
    },
  };
}

function backendCommand(): { command: string; args: string[] } {
  // Tests may substitute a tiny deterministic backend. Never honor the seam
  // outside NODE_ENV=test, so production cannot be redirected through env.
  const fixture = process.env.NODE_ENV === 'test'
    ? process.env.IMCODES_MEMORY_MCP_TEST_BACKEND_ENTRY
    : undefined;
  if (fixture) return { command: process.execPath, args: [fixture] };
  const entry = process.argv[1];
  if (!entry) throw new Error('memory_mcp_entry_unavailable');
  return {
    command: process.execPath,
    args: [...process.execArgv, entry, 'memory', 'mcp'],
  };
}

/**
 * A tiny, durable stdio endpoint in front of the heavyweight memory server.
 * It answers initialize/tools-list from immutable local data and owns backend
 * restart, so a cold import, crash, or watchdog termination cannot disconnect
 * the SDK's MCP transport generation.
 */
export async function runMemoryMcpBootstrap(): Promise<void> {
  const configuredMode = process.env.IMCODES_MCP_TOOL_CATALOG_MODE === 'static_full'
    ? 'static_full'
    : 'dynamic';
  let cachedTools: Tool[] = catalogs[configuredMode];
  let backend: ChildProcessWithoutNullStreams | null = null;
  let backendReady = false;
  let generation = 0;
  let restartAttempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let stableBackendTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;
  let clientInitialized = false;
  const queued: QueuedMessage[] = [];
  const inFlight = new Map<string, InFlightRequest>();
  const inFlightRequestTimeoutMs = testOnlyDuration(
    'IMCODES_MEMORY_MCP_TEST_REQUEST_TIMEOUT_MS',
    IN_FLIGHT_REQUEST_TIMEOUT_MS,
  );
  const toolCallDefaultTimeoutMs = testOnlyDuration(
    'IMCODES_MEMORY_MCP_TEST_TOOL_CALL_TIMEOUT_MS',
    TOOL_CALL_DEFAULT_TIMEOUT_MS,
  );
  const toolCallTimeoutHeadroomMs = testOnlyDuration(
    'IMCODES_MEMORY_MCP_TEST_TOOL_TIMEOUT_HEADROOM_MS',
    TOOL_CALL_TIMEOUT_HEADROOM_MS,
  );
  const stableBackendUptimeMs = testOnlyDuration(
    'IMCODES_MEMORY_MCP_TEST_STABLE_UPTIME_MS',
    BACKEND_STABLE_UPTIME_MS,
  );
  const owner: SessionResourceOwner | null = (() => {
    const sessionName = process.env.IMCODES_SESSION?.trim()
      || process.env.IMCODES_DAEMON_SESSION_NAME?.trim();
    const sessionInstanceId = process.env[SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]?.trim();
    const runtimeEpoch = process.env[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]?.trim();
    return sessionName && sessionInstanceId && runtimeEpoch
      ? { sessionName, sessionInstanceId, runtimeEpoch }
      : null;
  })();
  const resourceRegistry = owner ? new SessionResourceRegistry() : null;
  const resourceId = owner ? `mcp-bootstrap:${owner.runtimeEpoch}:${process.pid}` : null;
  const registration = owner && resourceRegistry && resourceId
    ? resourceRegistry.register({
      resourceId,
      kind: SESSION_RESOURCE_KIND.MCP,
      owner,
      handle: { type: SESSION_RESOURCE_HANDLE_TYPE.PID, pid: process.pid },
    }).catch((error: unknown) => {
      process.stderr.write(`[memory-mcp] bootstrap resource registration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    })
    : Promise.resolve();

  const idKey = (id: JsonRpcId): string => `${typeof id}:${String(id)}`;

  const sendBackend = (message: JsonRpcMessage): boolean => {
    if (!backend?.stdin.writable) return false;
    backend.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  };

  const notifyWarning = (message: string) => {
    process.stderr.write(`[memory-mcp] ${message}\n`);
    if (clientInitialized) {
      writeMessage({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'warning', logger: 'imcodes-memory', data: message },
      });
    }
  };

  const clearInFlight = (key: string): InFlightRequest | undefined => {
    const request = inFlight.get(key);
    if (!request) return undefined;
    clearTimeout(request.timer);
    inFlight.delete(key);
    return request;
  };

  const trackInFlight = (
    id: JsonRpcId,
    message: JsonRpcMessage,
    child: ChildProcessWithoutNullStreams,
    currentGeneration: number,
  ) => {
    const key = idKey(id);
    clearInFlight(key);
    const declaredToolTimeoutMs = requestedToolTimeoutMs(message);
    const timeoutMs = message.method === 'tools/call'
      ? (declaredToolTimeoutMs === null
          ? toolCallDefaultTimeoutMs
          : declaredToolTimeoutMs + toolCallTimeoutHeadroomMs)
      : inFlightRequestTimeoutMs;
    const timer = setTimeout(() => {
      const request = inFlight.get(key);
      if (!request || request.generation !== currentGeneration) return;
      inFlight.delete(key);
      writeMessage(errorResponse(id, -32002, 'memory_mcp_backend_request_timeout'));
      notifyWarning('backend request timed out; restarting it without replaying the request');
      if (backend === child) terminateBackend(child);
    }, timeoutMs);
    timer.unref?.();
    inFlight.set(key, { id, generation: currentGeneration, timer });
  };

  const flushQueued = () => {
    if (!backendReady) return;
    while (queued.length > 0) {
      const item = queued.shift();
      if (!item) break;
      if (item.timer) clearTimeout(item.timer);
      const id = requestId(item.message);
      const child = backend;
      if (id !== undefined && child) trackInFlight(id, item.message, child, generation);
      sendBackend(item.message);
    }
  };

  const enqueue = (message: JsonRpcMessage) => {
    const id = requestId(message);
    if (queued.length >= MAX_QUEUED_REQUESTS) {
      if (id !== undefined) writeMessage(errorResponse(id, -32001, 'memory_mcp_backend_queue_full'));
      return;
    }
    const item: QueuedMessage = { message, timer: null };
    if (id !== undefined) {
      item.timer = setTimeout(() => {
        const index = queued.indexOf(item);
        if (index >= 0) queued.splice(index, 1);
        writeMessage(errorResponse(id, -32002, 'memory_mcp_backend_unavailable'));
      }, QUEUED_REQUEST_TIMEOUT_MS);
      item.timer.unref?.();
    }
    queued.push(item);
  };

  const scheduleRestart = () => {
    if (shuttingDown || restartTimer) return;
    const delay = RESTART_DELAYS_MS[Math.min(restartAttempt, RESTART_DELAYS_MS.length - 1)];
    restartAttempt += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startBackend();
    }, delay);
    restartTimer.unref?.();
  };

  const terminateBackend = (child: ChildProcessWithoutNullStreams) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 2_000);
    force.unref?.();
  };

  const startBackend = () => {
    if (shuttingDown || backend) return;
    generation += 1;
    const currentGeneration = generation;
    const command = backendCommand();
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        [IMCODES_MEMORY_MCP_BACKEND_ENV]: '1',
        [IMCODES_MCP_PARENT_PID_ENV]: String(process.pid),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    backend = child;
    backendReady = false;
    const initializeId = `__imcodes_bootstrap_${currentGeneration}_initialize`;
    const listId = `__imcodes_bootstrap_${currentGeneration}_tools`;

    startupTimer = setTimeout(() => {
      if (backend === child && !backendReady) {
        notifyWarning('backend startup exceeded 60s; restarting it without dropping the MCP connection');
        terminateBackend(child);
      }
    }, BACKEND_START_TIMEOUT_MS);
    startupTimer.unref?.();

    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on('line', (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        notifyWarning('backend emitted invalid JSON; line discarded');
        return;
      }
      if (message.id === initializeId) {
        sendBackend({ jsonrpc: '2.0', method: 'notifications/initialized' });
        sendBackend({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} });
        return;
      }
      if (message.id === listId) {
        const result = message.result;
        if (result && typeof result === 'object' && Array.isArray((result as { tools?: unknown }).tools)) {
          const next = (result as { tools: Tool[] }).tools;
          const changed = JSON.stringify(next) !== JSON.stringify(cachedTools);
          cachedTools = next;
          backendReady = true;
          if (stableBackendTimer) clearTimeout(stableBackendTimer);
          stableBackendTimer = setTimeout(() => {
            if (backend === child && backendReady) restartAttempt = 0;
          }, stableBackendUptimeMs);
          stableBackendTimer.unref?.();
          if (startupTimer) clearTimeout(startupTimer);
          startupTimer = null;
          flushQueued();
          if (changed || currentGeneration > 1) {
            writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
          }
        } else {
          notifyWarning('backend returned an invalid tools catalog; restarting it');
          terminateBackend(child);
        }
        return;
      }
      if (message.method === 'notifications/tools/list_changed') {
        sendBackend({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} });
        return;
      }
      const id = requestId(message);
      if (id !== undefined && !clearInFlight(idKey(id))) {
        // The request already timed out (or belongs to a retired generation).
        // Never emit a second terminal response after the timeout.
        return;
      }
      writeMessage(message);
    });
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', (error) => notifyWarning(`backend process error: ${error.message}`));
    child.on('exit', (code, signal) => {
      output.close();
      if (backend !== child) return;
      backend = null;
      backendReady = false;
      for (const request of inFlight.values()) {
        clearTimeout(request.timer);
        writeMessage(errorResponse(request.id, -32003, 'memory_mcp_backend_restarted'));
      }
      inFlight.clear();
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      if (stableBackendTimer) clearTimeout(stableBackendTimer);
      stableBackendTimer = null;
      if (!shuttingDown) {
        notifyWarning(`backend exited (${signal ?? code ?? 'unknown'}); reconnecting automatically`);
        scheduleRestart();
      }
    });
    sendBackend({
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'imcodes-memory-bootstrap', version: '0.1.0' },
      },
    });
  };

  const shutdown = async (releaseOwnResource = true) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (startupTimer) clearTimeout(startupTimer);
    if (stableBackendTimer) clearTimeout(stableBackendTimer);
    for (const item of queued.splice(0)) if (item.timer) clearTimeout(item.timer);
    for (const request of inFlight.values()) clearTimeout(request.timer);
    inFlight.clear();
    const child = backend;
    backend = null;
    if (child) terminateBackend(child);
    await registration;
    if (releaseOwnResource && owner && resourceRegistry && resourceId) {
      await resourceRegistry.releaseResource(
        resourceId,
        owner,
        SESSION_RESOURCE_RELEASE_REASON.SESSION_COMPLETED,
      ).catch(() => {});
    }
  };

  const declaredParentPid = Number(process.env[IMCODES_MCP_PARENT_PID_ENV]);
  const configuredParentPollMs = Number(process.env.IMCODES_MCP_PARENT_POLL_MS);
  installMcpStdioLifecycle({
    stdin: process.stdin,
    shutdown,
    exit: (code) => process.exit(code),
    getParentPid: () => process.ppid,
    initialParentPid: MCP_PROCESS_START_PARENT_PID,
    ...(Number.isSafeInteger(declaredParentPid) && declaredParentPid > 0
      ? { expectedParentPid: declaredParentPid }
      : {}),
    onArmed: (parentPid) => {
      process.stderr.write(`[memory-mcp] parent liveness guard armed (parent=${parentPid})\n`);
    },
    ...(Number.isFinite(configuredParentPollMs) && configuredParentPollMs > 0
      ? { parentPollMs: configuredParentPollMs }
      : {}),
  });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      writeMessage(errorResponse(null, -32700, 'Parse error'));
      return;
    }
    const id = requestId(message);
    if (message.method === 'initialize' && id !== undefined) {
      const response = serverInfo((message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion);
      response.id = id;
      writeMessage(response);
      return;
    }
    if (message.method === 'notifications/initialized') {
      clientInitialized = true;
      return;
    }
    if (message.method === 'ping' && id !== undefined) {
      writeMessage({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (message.method === 'tools/list' && id !== undefined) {
      // Before hydration this is the immutable generated catalog and therefore
      // never waits on the heavy graph. Once the backend is healthy, ask it
      // directly so a discovery-triggered publication cannot race a stale
      // cached reply between list_changed and our private refresh.
      const child = backend;
      if (backendReady && child && sendBackend(message)) {
        trackInFlight(id, message, child, generation);
      } else {
        writeMessage({ jsonrpc: '2.0', id, result: { tools: cachedTools } });
      }
      return;
    }
    const child = backend;
    if (backendReady && child && sendBackend(message)) {
      if (id !== undefined) trackInFlight(id, message, child, generation);
      return;
    }
    enqueue(message);
  });
  input.on('close', () => { void shutdown(); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    // A registry orphan sweep holds the registry lock while signalling us.
    // Do not contend for that same lock; the sweeping owner removes the row.
    process.once(signal, () => { void shutdown(false).finally(() => process.exit(0)); });
  }
  startBackend();
}
