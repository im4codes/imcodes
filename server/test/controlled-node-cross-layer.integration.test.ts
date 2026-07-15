/**
 * Local product-path contract test: node result production -> authenticated
 * Bridge validator -> generation-bound registry -> real machine-exec HTTP route
 * -> bounded daemon decoder -> real MCP SDK tools/list + tools/call.
 */
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import type { ComputerUseFrame, ComputerUseResult } from '../../shared/computer-use.js';
import {
  NODE_ROLE,
  type RemoteExecOutputChunk,
  type RemoteExecRequest,
  type RemoteExecResult,
} from '../../shared/remote-exec.js';
import { createDaemonMachineToolDeps } from '../../src/daemon/machine-mcp-deps.js';
import { execRemote as daemonExecRemote, MachineControlPlaneError } from '../../src/daemon/machine-exec-client.js';
import { computerUseCall as daemonComputerUseCall } from '../../src/daemon/computer-use-client.js';
import { registerMemoryMcpTools, type MachineToolDeps } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { MachineExecWorker } from '../../src/node/machine-exec-worker.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import {
  __setMachineExecRelayDeadlineBufferMsForTests,
  createMachineExecRoutes,
  machineExecAuditIntentStore,
} from '../src/routes/machine-exec.js';
import { computerUseRelayDeadlineMs, createMachineComputerUseRoutes } from '../src/routes/machine-computer-use.js';
import { WsBridge } from '../src/ws/bridge.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const stubCaller = {} as unknown as McpRuntimeCaller;

let db: Database;
let source: { serverId: string; token: string };
let target: { serverId: string; token: string };
let app: Hono;
let bridge: WsBridge;
let socket: ControlledLoopbackSocket;

let holdStarted: (() => void) | undefined;
let releaseHolds: Array<() => void> = [];

const runControlled = async (
  request: RemoteExecRequest,
  options: { signal?: AbortSignal; onChunk?: (chunk: RemoteExecOutputChunk) => void } = {},
): Promise<RemoteExecResult> => {
  if (request.command === 'hold') {
    holdStarted?.();
    await new Promise<void>((resolve) => { releaseHolds.push(resolve); });
    return { requestId: request.requestId, ok: true, exitCode: 0, stdout: 'released', stderr: '', durationMs: 2 };
  }
  if (request.command === 'nonzero') {
    return { requestId: request.requestId, ok: true, exitCode: 7, stdout: 'nonzero', stderr: '', durationMs: 3 };
  }
  if (request.command === 'timeout') {
    return { requestId: request.requestId, ok: false, exitCode: null, stdout: '', stderr: '', timedOut: true, durationMs: 1_000, error: 'timeout' };
  }
  if (request.command === 'spawn') {
    return { requestId: request.requestId, ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 1, error: 'spawn failed' };
  }
  if (request.command === 'signal') {
    return { requestId: request.requestId, ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 2, error: 'terminated by signal' };
  }
  if (request.command === 'stream') {
    options.onChunk?.({ seq: 0, stream: 'stdout', chunk: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    options.onChunk?.({ seq: 1, stream: 'stderr', chunk: 'warn' });
    options.onChunk?.({ seq: 2, stream: 'stdout', chunk: 'second' });
    return { requestId: request.requestId, ok: true, exitCode: 0, stdout: 'firstsecond', stderr: 'warn', durationMs: 30 };
  }
  return { requestId: request.requestId, ok: true, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 };
};

type ResultMode = 'worker' | 'malformed' | 'lost';

class ControlledLoopbackSocket extends EventEmitter {
  readyState = 1;
  closed = false;
  mode: ResultMode = 'worker';
  readonly worker = new MachineExecWorker(runControlled);

  send(data: string | Buffer, _options?: unknown, callback?: (error?: Error) => void): void {
    callback?.();
    if (typeof data !== 'string') return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (message.type === DAEMON_COMMAND_TYPES.COMPUTER_USE) {
      queueMicrotask(() => {
        if (this.mode === 'lost') return;
        if (this.mode === 'malformed') {
          this.emit('message', Buffer.from(JSON.stringify({
            type: DAEMON_MSG.COMPUTER_USE_RESULT,
            correlationId: message.correlationId,
            ok: true,
            tool: message.tool,
            content: [{ type: 'text', text: 'bad' }],
            durationMs: -1,
          })), false);
          return;
        }
        const request = message as unknown as ComputerUseFrame;
        const result: ComputerUseResult = {
          correlationId: request.correlationId,
          ok: true,
          tool: request.tool,
          content: [{ type: 'text', text: `computer:${request.tool}` }],
          durationMs: 5,
        };
        this.emit('message', Buffer.from(JSON.stringify({ type: DAEMON_MSG.COMPUTER_USE_RESULT, ...result })), false);
      });
      return;
    }
    if (message.type !== DAEMON_COMMAND_TYPES.MACHINE_EXEC) return;
    queueMicrotask(async () => {
      if (this.mode === 'lost') return;
      if (this.mode === 'malformed') {
        this.emit('message', Buffer.from(JSON.stringify({
          type: DAEMON_MSG.MACHINE_EXEC_RESULT,
          correlationId: message.correlationId,
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          error: '',
        })), false);
        return;
      }
      const reply = await this.worker.handle(message, (chunk) => {
        this.emit('message', Buffer.from(JSON.stringify({
          type: DAEMON_MSG.MACHINE_EXEC_CHUNK,
          correlationId: message.correlationId,
          ...chunk,
        })), false);
      });
      if (reply) this.emit('message', Buffer.from(JSON.stringify({ type: DAEMON_MSG.MACHINE_EXEC_RESULT, ...reply })), false);
    });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.worker.abortAll();
    this.emit('close');
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error('condition_timeout');
}

function appFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  return app.request(`${url.pathname}${url.search}`, init);
}

function machineDeps(overrides: { token?: string; unbound?: boolean; listFailure?: boolean } = {}): MachineToolDeps {
  return createDaemonMachineToolDeps({
    loadCredential: async () => overrides.unbound ? null : ({
      serverUrl: 'http://local.test',
      serverId: source.serverId,
      token: overrides.token ?? source.token,
    }),
    listMachines: async () => {
      if (overrides.listFailure) throw new MachineControlPlaneError('http_status', 'machines API returned http_503');
      return [{
        serverId: target.serverId,
        name: 'controlled-node',
        refName: 'node-linux',
        displayName: 'Linux Node',
        online: true,
        nodeRole: NODE_ROLE.CONTROLLED,
        execEnabled: true,
        os: 'linux',
        lastSeenMs: Date.now(),
      }];
    },
    execRemote: (options) => daemonExecRemote({ ...options, fetchImpl: appFetch as typeof fetch }),
    computerUseCall: (options) => daemonComputerUseCall({ ...options, fetchImpl: appFetch as typeof fetch }),
  });
}

async function connectMcp(deps: MachineToolDeps): Promise<Client> {
  const server = new McpServer({ name: 'controlled-node-cross-layer', version: '1.0.0' });
  registerMemoryMcpTools(server, stubCaller, { machineDeps: deps, nodeRole: NODE_ROLE.FULL });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cross-layer-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callExec(client: Client, command: string) {
  return client.callTool({
    name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE,
    arguments: { machine: 'node-linux', command, timeoutMs: 1_000 },
  });
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  const userId = `cross_${hex(5)}`;
  await createUser(db, userId);
  source = { serverId: `full_${hex(5)}`, token: hex(16) };
  target = { serverId: `ctl_${hex(5)}`, token: hex(16) };
  await createServer(db, source.serverId, userId, 'full', sha256(source.token));
  await db.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, revoked_at, ref_name, display_name, os)
     VALUES ($1,$2,'controlled',$3,'online',$4,$5,true,NULL,'node-linux','Linux Node','linux')`,
    [target.serverId, userId, sha256(target.token), Date.now(), NODE_ROLE.CONTROLLED],
  );

  app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: Database } }).env = { DB: db };
    await next();
  });
  app.route('/api/machine/exec', createMachineExecRoutes(undefined, machineExecAuditIntentStore));
  app.route('/api/machine/computer-use', createMachineComputerUseRoutes());

  bridge = WsBridge.get(target.serverId);
  socket = new ControlledLoopbackSocket();
  bridge.handleDaemonConnection(socket as never, db, {} as never);
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: target.serverId, token: target.token })), false);
  await waitFor(() => bridge.isDaemonConnected());
  __setMachineExecRelayDeadlineBufferMsForTests(0);
}, 30_000);

afterAll(async () => {
  __setMachineExecRelayDeadlineBufferMsForTests();
  socket?.close();
  await db?.close();
});

describe('controlled-node cross-layer product path', () => {
  it('streams node stdout/stderr through Bridge, HTTP NDJSON, daemon client, and MCP progress', async () => {
    socket.mode = 'worker';
    const client = await connectMcp(machineDeps());
    const progress: Array<{ progress: number; message?: string }> = [];
    const result = await client.callTool(
      {
        name: MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE,
        arguments: { machine: 'node-linux', command: 'stream', timeoutMs: 1_000 },
      },
      undefined,
      { onprogress: (update) => progress.push({ progress: update.progress, message: update.message }) },
    );

    expect(progress).toEqual([
      { progress: 1, message: '[stdout] first' },
      { progress: 2, message: '[stderr] warn' },
      { progress: 3, message: '[stdout] second' },
    ]);
    expect(result.structuredContent).toMatchObject({
      status: 'ok', outcome: 'completed', stdout: 'firstsecond', stderr: 'warn', exitCode: 0,
    });
    await client.close();
  });

  it('publishes canonical machine identity and carries non-zero completion through tools/list and tools/call', async () => {
    socket.mode = 'worker';
    const client = await connectMcp(machineDeps());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      MEMORY_MCP_TOOL_NAMES.LIST_MACHINES,
      MEMORY_MCP_TOOL_NAMES.EXEC_REMOTE,
      MEMORY_MCP_TOOL_NAMES.SEND_FILE_TO_MACHINE,
      MEMORY_MCP_TOOL_NAMES.FETCH_FILE_FROM_MACHINE,
      MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS,
      MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
    ]));
    const listed = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.LIST_MACHINES, arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      status: 'ok',
      machines: [{ name: 'node-linux', os: 'linux', role: NODE_ROLE.CONTROLLED, online: true, execEnabled: true }],
    });
    const result = await callExec(client, 'nonzero');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'ok', outcome: 'completed', ok: true, exitCode: 7, stdout: 'nonzero' });
    await client.close();
  });

  it('carries computer_use_call through MCP, daemon client, HTTP route, Bridge, and generation-bound result registry', async () => {
    expect(computerUseRelayDeadlineMs({ tool: 'shell_session1', timeoutMs: 900_000 })).toBe(930_000);
    expect(computerUseRelayDeadlineMs({ tool: 'list_apps', timeoutMs: 120_000 })).toBe(150_000);
    socket.mode = 'worker';
    const client = await connectMcp(machineDeps());
    const docs = await client.callTool({ name: MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_DOCS, arguments: { topic: 'workflow' } });
    expect(docs.isError).toBeFalsy();
    expect(docs.structuredContent).toMatchObject({ status: 'ok', topic: 'workflow' });
    const result = await client.callTool({
      name: MEMORY_MCP_TOOL_NAMES.COMPUTER_USE_CALL,
      arguments: { machine: 'node-linux', tool: 'shell_session1', timeoutMs: 900_000 },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'ok',
      outcome: 'completed',
      result: { ok: true, tool: 'shell_session1', content: [{ type: 'text', text: 'computer:shell_session1' }] },
    });
    await client.close();
  });

  it.each([
    ['timeout', 'node_timeout', 'timeout'],
    ['spawn', 'spawn_error', 'spawn failed'],
    ['signal', 'spawn_error', 'terminated by signal'],
  ] as const)('carries %s failure semantics without collapsing the outcome', async (command, outcome, error) => {
    socket.mode = 'worker';
    const client = await connectMcp(machineDeps());
    const result = await callExec(client, command);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'ok', outcome, ok: false, exitCode: null, error });
    await client.close();
  });

  it('uses the real worker concurrency gate so 10 calls run and the 11th returns spawn_error/busy', async () => {
    socket.mode = 'worker';
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let startedCount = 0;
    holdStarted = () => {
      startedCount++;
      if (startedCount === 10) started();
    };
    const client = await connectMcp(machineDeps());
    const running = Array.from({ length: 10 }, () => callExec(client, 'hold'));
    try {
      await startedPromise;
      expect(socket.worker.inFlightCount).toBe(10);
      const overflow = await callExec(client, 'nonzero');
      expect(overflow.structuredContent).toMatchObject({ status: 'ok', outcome: 'spawn_error', ok: false, error: 'busy' });
    } finally {
      for (const release of releaseHolds) release();
      await Promise.allSettled(running);
      holdStarted = undefined;
      releaseHolds = [];
      await client.close();
    }
  });

  it.each([
    ['malformed', 'malformed strict Bridge result'],
    ['lost', 'response loss after dispatch'],
  ] as const)('maps %s to indeterminate through route + bounded decoder', async (mode) => {
    socket.mode = mode;
    const client = await connectMcp(machineDeps());
    const result = await callExec(client, 'nonzero');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'ok', outcome: 'dispatched_no_result' });
    await client.close();
  });

  it('keeps auth denial retry-safe and version-decodes it instead of throwing', async () => {
    socket.mode = 'worker';
    const client = await connectMcp(machineDeps({ token: 'wrong-token' }));
    const result = await callExec(client, 'nonzero');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'ok', outcome: 'not_dispatched' });
    await client.close();
  });

  it.each([
    [{ unbound: true }, MCP_ERROR_REASONS.FEATURE_DISABLED],
    [{ listFailure: true }, MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE],
  ] as const)('surfaces unbound/control-plane failure as typed MCP errors', async (options, reason) => {
    const client = await connectMcp(machineDeps(options));
    const result = await callExec(client, 'nonzero');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 'error', reason });
    await client.close();
  });
});
