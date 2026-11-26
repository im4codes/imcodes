import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionResourceRegistry } from '../../src/daemon/session-resource-registry.js';
import { SESSION_RESOURCE_LIFETIME, SESSION_RESOURCE_RELEASE_REASON } from '../../shared/session-resource-lifecycle.js';
import { IMCODES_MEMORY_MCP_BACKEND_ENV } from '../../src/daemon/mcp-stdio-lifecycle.js';

const openClients: Client[] = [];
const openProcesses: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.close()));
  for (const child of openProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

/** Every bootstrap now writes its exit to <IMCODES_HOME>/logs; never the real home. */
function isolatedImcodesHome(): string {
  return mkdtempSync(join(tmpdir(), 'memory-mcp-bootstrap-home-'));
}

function connect(env: Record<string, string>): { client: Client; transport: StdioClientTransport; stderr: string[] } {
  const client = new Client({ name: 'bootstrap-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      IMCODES_HOME: isolatedImcodesHome(),
      NODE_ENV: 'test',
      IMCODES_MCP_TOOL_CATALOG_MODE: 'static_full',
      IMCODES_MEMORY_MCP_TEST_BACKEND_ENTRY: resolve('test/fixtures/memory-mcp-test-backend.mjs'),
      ...env,
    },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  openClients.push(client);
  return { client, transport, stderr };
}

async function waitForFixtureCatalog(client: Client, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await client.listTools()).tools.some((tool) => tool.name === 'fixture_echo')) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  } while (Date.now() < deadline);
  throw new Error('fixture catalog was not published');
}

function bootstrapTimingProfile(isIntelMac: boolean) {
  const backendDelayMs = isIntelMac ? 10_000 : 6_000;
  return {
    backendDelayMs,
    probeBudgetMs: isIntelMac ? 6_000 : 2_000,
    initialCatalogBudgetMs: isIntelMac ? 7_000 : 4_000,
    catalogWaitMs: isIntelMac ? backendDelayMs + 4_000 : 8_000,
  };
}

async function waitForStarts(path: string, count: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  do {
    const values = (await readFile(path, 'utf8').catch(() => ''))
      .trim().split('\n').filter(Boolean).map(Number);
    if (values.length >= count) return values;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  throw new Error(`backend started fewer than ${count} times`);
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  } while (Date.now() < deadline);
  throw new Error('condition was not reached');
}

function rawBootstrap(env: Record<string, string>): {
  child: ChildProcessWithoutNullStreams;
  messages: Array<Record<string, unknown>>;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'memory', 'mcp'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      IMCODES_HOME: isolatedImcodesHome(),
      NODE_ENV: 'test',
      IMCODES_MCP_TOOL_CATALOG_MODE: 'static_full',
      IMCODES_MEMORY_MCP_TEST_BACKEND_ENTRY: resolve('test/fixtures/memory-mcp-test-backend.mjs'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  openProcesses.push(child);
  const messages: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    messages.push(JSON.parse(line) as Record<string, unknown>);
  });
  return { child, messages };
}

describe('memory MCP lightweight bootstrap', () => {
  it.each([{ method: 'server/discover', id: 0 }, { method: 'future/unknown', id: 'probe' }])('rejects pre-initialize protocol probe $method promptly so legacy negotiation can continue', async ({ method, id }) => {
    const profile = bootstrapTimingProfile(process.platform === 'darwin' && process.arch === 'x64');
    const { child, messages } = rawBootstrap({ IMCODES_MEMORY_MCP_TEST_DELAY_MS: String(profile.backendDelayMs) });
    const started = Date.now();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`);
    const reply = await waitFor(() => messages.find(message => message.id === id), profile.probeBudgetMs);
    expect(reply).toMatchObject({ error: { code: -32601, message: 'Method not found' } });
    expect(Date.now() - started).toBeLessThan(profile.probeBudgetMs);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'future/notification', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe-fallback', version: '1' } } })}\n`);
    const initReply = await waitFor(() => messages.find(message => message.id === 'initialize'));
    expect(initReply).toHaveProperty('result.serverInfo.name', 'imcodes-memory');
    expect(initReply).toHaveProperty('result.instructions');
    expect(String((initReply?.result as { instructions?: unknown })?.instructions ?? '')).toContain('[CloudDoc: <name> | id=<docId>]');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    expect(await waitFor(() => messages.find(message => message.id === 2))).toHaveProperty('result.tools');
    expect(messages.filter(message => message.error)).toHaveLength(1);
  });

  async function assertDelayedBackendBootstrap(isIntelMac: boolean): Promise<void> {
    const profile = bootstrapTimingProfile(isIntelMac);
    expect(profile.probeBudgetMs).toBeLessThan(profile.backendDelayMs);
    expect(profile.initialCatalogBudgetMs).toBeLessThan(profile.backendDelayMs);
    expect(profile.catalogWaitMs).toBeGreaterThan(profile.backendDelayMs);

    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-delayed-'));
    const startLog = join(dir, 'starts.log');
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_DELAY_MS: String(profile.backendDelayMs),
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
    });
    const startedAt = Date.now();
    await client.connect(transport);
    const initial = await client.listTools();
    // Source-mode includes the tsx loader; the shipped JS path is much faster.
    // This bound is still below the deliberately blocked backend and far below
    // the MCP clients' 30s CONNECT_TIMEOUT.
    expect(Date.now() - startedAt).toBeLessThan(profile.initialCatalogBudgetMs);
    expect(initial.tools.some((tool) => tool.name === 'mcp_tool_search')).toBe(true);
    expect(initial.tools.length).toBeGreaterThan(35);
    expect(await readFile(startLog, 'utf8').catch(() => '')).toBe('');

    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'ready' } }))
      .resolves.toMatchObject({ structuredContent: { echoed: 'ready' } });
    await waitForFixtureCatalog(client, profile.catalogWaitMs);
  }

  it('dispatches before the daemon CLI graph and serves initialize/catalog while backend import is delayed', async () => {
    const source = await readFile(resolve('src/index.ts'), 'utf8');
    expect(/^import .*commander/m.test(source)).toBe(false);
    expect(source.indexOf("import('./daemon/memory-mcp-bootstrap.js')"))
      .toBeLessThan(source.indexOf("import('./cli.js')"));

    await assertDelayedBackendBootstrap(process.platform === 'darwin' && process.arch === 'x64');
  }, 30_000);

  it('completes delayed fixture catalog and tool execution under the Intel Mac 10s timing profile', async () => {
    await assertDelayedBackendBootstrap(true);
  }, 30_000);

  it('keeps stdio connected and automatically replaces a backend that crashes during startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-reconnect-'));
    const { client, transport, stderr } = connect({
      IMCODES_MEMORY_MCP_TEST_CRASH_MARKER: join(dir, 'crashed'),
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.some((tool) => tool.name === 'mcp_tool_search')).toBe(true);

    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'recovered' } }))
      .resolves.toMatchObject({ structuredContent: { echoed: 'recovered' } });
    await waitForFixtureCatalog(client);
    expect(stderr.join('')).toContain('reconnecting automatically');
  }, 15_000);

  it('does not restart a deterministic caller-env rejection and returns its reason', async () => {
    const home = isolatedImcodesHome();
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-rejected-'));
    const startLog = join(dir, 'starts.log');
    const { child, messages } = rawBootstrap({
      IMCODES_HOME: home,
      IMCODES_MEMORY_MCP_TEST_CALLER_ENV_ERROR: 'IMCODES_DAEMON_SESSION_NAME is invalid',
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' } },
    })}\n`);
    await waitFor(() => messages.find((message) => message.id === 1));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 77, method: 'tools/call',
      params: { name: 'fixture_echo', arguments: { value: 'rejected' } },
    })}\n`);
    const response = await waitFor(() => messages.find((message) => message.id === 77), 8_000);
    expect(response).toMatchObject({
      error: {
        code: -32004,
        message: 'memory_mcp_backend_caller_rejected: IMCODES_DAEMON_SESSION_NAME is invalid',
      },
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    expect((await readFile(startLog, 'utf8')).trim().split('\n').filter(Boolean)).toHaveLength(1);
    const events = (await readFile(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(expect.objectContaining({
      event: 'backend_exit',
      reason: 'caller_env_rejected',
      error: 'IMCODES_DAEMON_SESSION_NAME is invalid',
    }));
  }, 15_000);

  it('registers the stable bootstrap PID so a stopped session can reap the whole backend chain', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memory-mcp-owner-'));
    const { client, transport } = connect({
      HOME: home,
      IMCODES_HOME: home,
      IMCODES_DAEMON_SESSION_NAME: 'deck_sub_owned',
      IMCODES_RESOURCE_SESSION_INSTANCE_ID: 'instance-owned',
      IMCODES_RESOURCE_RUNTIME_EPOCH: 'epoch-owned',
    });
    await client.connect(transport);
    const registryDir = join(home, 'session-resources');
    const deadline = Date.now() + 5_000;
    let record: { resourceId?: string; handle?: { pid?: number } } | null = null;
    do {
      const names = await readdir(registryDir).catch(() => []);
      for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
        record = JSON.parse(await readFile(join(registryDir, name), 'utf8')) as typeof record;
        if (record?.resourceId?.startsWith('mcp-bootstrap:')) break;
        record = null;
      }
      if (!record) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    } while (!record && Date.now() < deadline);
    expect(record).toMatchObject({
      resourceId: expect.stringMatching(/^mcp-bootstrap:epoch-owned:/),
      handle: { pid: transport.pid },
    });
  });

  it('registers the real supervised backend under the watchdog-safe mcp-backend prefix', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memory-mcp-backend-owner-'));
    const { client, transport } = connect({
      HOME: home,
      IMCODES_HOME: home,
      IMCODES_MEMORY_MCP_TEST_BACKEND_ENTRY: '',
      IMCODES_DAEMON_SESSION_NAME: 'deck_sub_backend_owned',
      IMCODES_RESOURCE_SESSION_INSTANCE_ID: 'instance-backend-owned',
      IMCODES_RESOURCE_RUNTIME_EPOCH: 'epoch-backend-owned',
    });
    await client.connect(transport);
    await client.callTool({ name: 'mcp_tool_search', arguments: { query: 'session_runtime_identity_get' } }).catch(() => {});
    const registryDir = join(home, 'session-resources');
    // The backend-owner registration happens after the source-mode child has
    // loaded the daemon graph and started its supervised generation.  Under a
    // saturated runner that startup can legitimately take several seconds;
    // keep polling the observable registry rather than failing the test before
    // the child has had a chance to publish its ownership record.
    const record = await waitFor(async () => {
      const names = await readdir(registryDir).catch(() => []);
      for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
        const candidate = JSON.parse(await readFile(join(registryDir, name), 'utf8')) as {
          resourceId?: string;
          handle?: { pid?: number };
        };
        if (candidate.resourceId?.startsWith('mcp-backend:epoch-backend-owned:')) return candidate;
      }
      return undefined;
    }, 30_000);
    expect(record.resourceId).toMatch(/^mcp-backend:epoch-backend-owned:/);
    expect(record.handle?.pid).not.toBe(transport.pid);
  }, 45_000);

  it.runIf(process.platform !== 'win32')('a reaped real backend exits gracefully instead of waiting for the reaper registry lock', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memory-mcp-signal-'));
    const owner = { sessionName: 'deck_e2e_mcpsignal_w1', sessionInstanceId: 'signal-instance', runtimeEpoch: 'signal-epoch' };
    const registry = new SessionResourceRegistry({ directory: join(home, 'session-resources') });
    const { child, messages } = rawBootstrap({
      HOME: home, IMCODES_HOME: home,
      [IMCODES_MEMORY_MCP_BACKEND_ENV]: '1',
      IMCODES_DAEMON_SESSION_NAME: owner.sessionName,
      IMCODES_RESOURCE_SESSION_INSTANCE_ID: owner.sessionInstanceId,
      IMCODES_RESOURCE_RUNTIME_EPOCH: owner.runtimeEpoch,
    });
    child.stderr.resume();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'signal-test', version: '1' } },
    })}\n`);
    await waitFor(() => messages.find((message) => message.id === 1), 30_000);
    const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
    expect(await registry.releaseOwner(owner, SESSION_RESOURCE_RELEASE_REASON.SESSION_COMPLETED)).toEqual({ released: 1, failed: 0 });
    expect(await exit).toEqual({ code: 0, signal: null });
    expect(await registry.list()).toEqual([]);
  }, 40_000);

  it.runIf(process.platform !== 'win32')('reset stops supervisors before their real backends without reconnecting or force-killing them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memory-mcp-reset-'));
    const owner = { sessionName: 'deck_e2e_mcpreset_w1', sessionInstanceId: 'reset-instance', runtimeEpoch: 'old-a' };
    const registry = new SessionResourceRegistry({ directory: join(home, 'session-resources') });
    // Two old thread generations reproduce the production batch. Alphabetic
    // resource order puts BOTH backends before either live supervisor.
    for (const epoch of ['old-a', 'old-b']) {
      const { client, transport } = connect({
        HOME: home, IMCODES_HOME: home,
        IMCODES_MEMORY_MCP_TEST_BACKEND_ENTRY: '',
        IMCODES_DAEMON_SESSION_NAME: owner.sessionName,
        IMCODES_RESOURCE_SESSION_INSTANCE_ID: owner.sessionInstanceId,
        IMCODES_RESOURCE_RUNTIME_EPOCH: epoch,
        IMCODES_MCP_HOST_LIFETIME: SESSION_RESOURCE_LIFETIME.PROVIDER_HOST,
      });
      await client.connect(transport);
      await client.callTool({ name: 'mcp_tool_search', arguments: { query: 'session_runtime_identity_get' } }).catch(() => {});
      await waitFor(async () => (await registry.list()).find((row) => row.resourceId.startsWith(`mcp-backend:${epoch}:`)), 30_000);
    }
    expect(await registry.list()).toHaveLength(4);
    const result = await registry.releaseOwner(owner, SESSION_RESOURCE_RELEASE_REASON.SESSION_COMPLETED);
    expect(result).toEqual({ released: 4, failed: 0 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
    const events = (await readFile(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8'))
      .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.event === 'backend_exit' && event.expected === false),
      'intentional reset must not look like a crash and start a replacement').toEqual([]);
    expect(await registry.list(), 'no backend may re-register after the reset snapshot').toEqual([]);
  }, 45_000);

  it('keeps increasing reconnect backoff while a ready backend flaps before the stable window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-flap-'));
    const startLog = join(dir, 'starts.log');
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
      IMCODES_MEMORY_MCP_TEST_CRASH_AFTER_READY_MS: '20',
      IMCODES_MEMORY_MCP_TEST_STABLE_UPTIME_MS: '5000',
    });
    await client.connect(transport);
    void client.callTool({ name: 'fixture_echo', arguments: { value: 'wake' } }).catch(() => {});
    const starts = await waitForStarts(startLog, 4);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(750);
    expect(starts[3]! - starts[2]!).toBeGreaterThanOrEqual(2_500);
  }, 12_000);

  it('times out a hung in-flight call, restarts its backend, and never replays it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-hung-call-'));
    const hangMarker = join(dir, 'hung');
    const startLog = join(dir, 'starts.log');
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_HANG_CALL_MARKER: hangMarker,
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
      IMCODES_MEMORY_MCP_TEST_TOOL_CALL_TIMEOUT_MS: '150',
    });
    await client.connect(transport);
    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'hang-once' } }))
      .rejects.toThrow(/memory_mcp_backend_request_timeout/);
    await waitForStarts(startLog, 2);
    await waitForFixtureCatalog(client);
    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'after-timeout' } }))
      .resolves.toMatchObject({ structuredContent: { echoed: 'after-timeout' } });
  }, 12_000);

  it('fails every in-flight request with backend-restarted when that generation exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-exit-call-'));
    const startLog = join(dir, 'starts.log');
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_EXIT_CALL_VALUE: 'exit-now',
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
    });
    await client.connect(transport);
    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'warmup' } }))
      .resolves.toMatchObject({ structuredContent: { echoed: 'warmup' } });
    await waitForFixtureCatalog(client);

    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'exit-now' } }))
      .rejects.toMatchObject({
        code: -32003,
        message: expect.stringMatching(/memory_mcp_backend_restarted/),
      });
    await waitForStarts(startLog, 2);
  }, 12_000);

  it('drops a backend reply that arrives after the proxy already timed out that request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-late-reply-'));
    const replyLog = join(dir, 'replies.log');
    const { child, messages } = rawBootstrap({
      IMCODES_MEMORY_MCP_TEST_TOOL_CALL_TIMEOUT_MS: '100',
      IMCODES_MEMORY_MCP_TEST_IGNORE_SIGTERM: '1',
      IMCODES_MEMORY_MCP_TEST_REPLY_LOG: replyLog,
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' } },
    })}\n`);
    await waitFor(() => messages.find((message) => message.id === 1));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 77, method: 'tools/call',
      params: { name: 'fixture_echo', arguments: { value: 'late', delayMs: 350 } },
    })}\n`);
    const timeout = await waitFor(() => messages.find((message) => message.id === 77));
    expect(timeout).toMatchObject({ error: { code: -32002, message: 'memory_mcp_backend_request_timeout' } });
    await waitFor(async () => (await readFile(replyLog, 'utf8').catch(() => '')).includes('77') || undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(messages.filter((message) => message.id === 77)).toHaveLength(1);
  }, 12_000);

  it('honors a tool-declared timeout instead of the generic RPC deadline', async () => {
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_REQUEST_TIMEOUT_MS: '150',
    });
    await client.connect(transport);
    await expect(client.callTool({
      name: 'fixture_echo',
      arguments: { value: 'declared-timeout', delayMs: 300, timeoutMs: 120_000 },
    })).resolves.toMatchObject({ structuredContent: { echoed: 'declared-timeout' } });
  }, 10_000);

  it('honors a tool-declared timeout that is shorter than the 15-minute default', async () => {
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_TOOL_CALL_TIMEOUT_MS: '5000',
      IMCODES_MEMORY_MCP_TEST_TOOL_TIMEOUT_HEADROOM_MS: '50',
    });
    await client.connect(transport);
    await expect(client.callTool({
      name: 'fixture_echo',
      arguments: { value: 'short-declared-timeout', delayMs: 500, timeoutMs: 100 },
    })).rejects.toThrow(/memory_mcp_backend_request_timeout/);
  }, 10_000);

  it('lets a healthy long-running tool call finish without delaying or failing concurrent work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-long-call-'));
    const startLog = join(dir, 'starts.log');
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
    });
    await client.connect(transport);

    const slow = client.callTool({
      name: 'fixture_echo',
      arguments: { value: 'slow', delayMs: 35_000 },
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await expect(client.callTool({
      name: 'fixture_echo',
      arguments: { value: 'fast', delayMs: 2_000 },
    })).resolves.toMatchObject({ structuredContent: { echoed: 'fast' } });
    await expect(slow).resolves.toMatchObject({ structuredContent: { echoed: 'slow' } });
    expect(await waitForStarts(startLog, 1)).toHaveLength(1);
  }, 50_000);

  it('stays lazy across initialize/ping/tools/list and reaps idle backend with transparent respawn', async () => {
    const home = isolatedImcodesHome();
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-idle-reap-'));
    const startLog = join(dir, 'starts.log');
    const { client, transport, stderr } = connect({
      HOME: home,
      IMCODES_HOME: home,
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
      IMCODES_MEMORY_MCP_TEST_BACKEND_IDLE_MS: '200',
    });
    await client.connect(transport);
    await client.ping();
    const initialTools = await client.listTools();
    expect(initialTools.tools.some((tool) => tool.name === 'mcp_tool_search')).toBe(true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect(await readFile(startLog, 'utf8').catch(() => ''), 'must not spawn backend before first real call').toBe('');

    // First real call wakes the backend and protects in-flight work past the idle TTL.
    await expect(client.callTool({
      name: 'fixture_echo',
      arguments: { value: 'in-flight-hold', delayMs: 350 },
    })).resolves.toMatchObject({ structuredContent: { echoed: 'in-flight-hold' } });
    expect(await waitForStarts(startLog, 1)).toHaveLength(1);

    // After the call settles and the idle window elapses, the backend exits cleanly without restart.
    const idleExitEvent = await waitFor(async () => {
      const log = await readFile(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8').catch(() => '');
      const events = log.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      return events.find((e) => e.event === 'backend_exit' && e.reason === 'idle_timeout');
    }, 5_000);
    expect(idleExitEvent).toMatchObject({ expected: true, reason: 'idle_timeout' });
    expect(stderr.join('')).not.toContain('reconnecting automatically');

    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    expect(await waitForStarts(startLog, 1)).toHaveLength(1);

    // Next real call transparently respawns generation 2 and succeeds.
    await expect(client.callTool({
      name: 'fixture_echo',
      arguments: { value: 'respawned' },
    })).resolves.toMatchObject({ structuredContent: { echoed: 'respawned' } });
    expect(await waitForStarts(startLog, 2)).toHaveLength(2);
  }, 15_000);

  it('replays published dynamic-catalog selection (without fallbackCall) before direct long-tail calls after idle reap', async () => {
    const home = isolatedImcodesHome();
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-dynamic-reap-'));
    const startLog = join(dir, 'starts.log');
    const callLog = join(dir, 'calls.log');
    const { client, transport } = connect({
      HOME: home,
      IMCODES_HOME: home,
      IMCODES_MCP_TOOL_CATALOG_MODE: 'dynamic',
      IMCODES_MEMORY_MCP_TEST_DYNAMIC_CATALOG: '1',
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
      IMCODES_MEMORY_MCP_TEST_CALL_LOG: callLog,
      IMCODES_MEMORY_MCP_TEST_BACKEND_IDLE_MS: '200',
    });
    await client.connect(transport);
    const initialList = (await client.listTools()).tools.map((tool) => tool.name);
    expect(initialList).toContain('mcp_tool_search');
    expect(initialList).not.toContain('fixture_echo');

    const searchResult = await client.callTool({
      name: 'mcp_tool_search',
      arguments: {
        query: 'fixture_echo',
        fallbackCall: { name: 'fixture_echo', arguments: { value: 'should-not-replay' } },
      },
    });
    expect(searchResult).toMatchObject({ structuredContent: { published: ['fixture_echo'], fallbackExecuted: true } });
    await waitForFixtureCatalog(client);

    // Wait for idle reap of backend generation 1.
    await waitFor(async () => {
      const log = await readFile(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8').catch(() => '');
      return log.includes('"idle_timeout"') ? true : undefined;
    }, 5_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));

    // Direct call on the same MCP client succeeds transparently on generation 2.
    await expect(client.callTool({
      name: 'fixture_echo',
      arguments: { value: 'after-idle-reap' },
    })).resolves.toMatchObject({ structuredContent: { echoed: 'after-idle-reap' } });
    expect(await waitForStarts(startLog, 2)).toHaveLength(2);

    const calls = (await readFile(callLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { name: string; arguments: Record<string, unknown> });
    // Calls: [gen1 search+fallback, gen2 search(activate:true, NO fallbackCall), gen2 fixture_echo]
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual({ name: 'mcp_tool_search', arguments: { query: 'fixture_echo', activate: true } });
    expect(calls[2]).toEqual({ name: 'fixture_echo', arguments: { value: 'after-idle-reap' } });
  }, 15_000);

  it('restores real-backend dynamic catalog publication across idle reap on direct long-tail call', async () => {
    const home = isolatedImcodesHome();
    const { client, transport } = connect({
      HOME: home,
      IMCODES_HOME: home,
      IMCODES_MCP_TOOL_CATALOG_MODE: 'dynamic',
      IMCODES_MEMORY_MCP_TEST_BACKEND_ENTRY: '',
      IMCODES_MEMORY_MCP_TEST_BACKEND_IDLE_MS: '250',
      IMCODES_DAEMON_USER_ID: 'user-real',
      IMCODES_DAEMON_NAMESPACE: JSON.stringify({ scope: 'personal', userId: 'user-real', projectId: 'github.com/acme/realproj' }),
      IMCODES_DAEMON_SERVER_ID: 'srv-real',
      IMCODES_DAEMON_SESSION_NAME: 'deck_real_w1',
      IMCODES_DAEMON_PROJECT_NAME: 'realproj',
      IMCODES_DAEMON_PROJECT_ROOT: '/tmp/realproj',
    });
    await client.connect(transport);

    const searchResult = await client.callTool({
      name: 'mcp_tool_search',
      arguments: { query: 'memory_injection_get' },
    });
    expect(searchResult).toMatchObject({ structuredContent: { status: 'ok', published: ['memory_injection_get'] } });
    await waitFor(async () => {
      const list = await client.listTools();
      return list.tools.some((t) => t.name === 'memory_injection_get') ? true : undefined;
    }, 8_000);

    // Wait for real backend generation 1 idle reap.
    await waitFor(async () => {
      const log = await readFile(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8').catch(() => '');
      return log.includes('"idle_timeout"') ? true : undefined;
    }, 8_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));

    // Direct call to memory_injection_get succeeds transparently after generation 2 replays mcp_tool_search.
    const injResult = await client.callTool({
      name: 'memory_injection_get',
      arguments: {},
    });
    expect(injResult).toMatchObject({
      structuredContent: { status: 'ok', enabled: true },
    });
  }, 20_000);

  it('tracks real-backend empty clear and fallbackCall business-error publication transitions across idle reap', async () => {
    const home = isolatedImcodesHome();
    const { client, transport } = connect({
      HOME: home,
      IMCODES_HOME: home,
      IMCODES_MCP_TOOL_CATALOG_MODE: 'dynamic',
      IMCODES_MEMORY_MCP_TEST_BACKEND_ENTRY: '',
      IMCODES_MEMORY_MCP_TEST_BACKEND_IDLE_MS: '250',
      IMCODES_DAEMON_USER_ID: 'user-real',
      IMCODES_DAEMON_NAMESPACE: JSON.stringify({ scope: 'personal', userId: 'user-real', projectId: 'github.com/acme/realproj' }),
      IMCODES_DAEMON_SERVER_ID: 'srv-real',
      IMCODES_DAEMON_SESSION_NAME: 'deck_real_w1',
      IMCODES_DAEMON_PROJECT_NAME: 'realproj',
      IMCODES_DAEMON_PROJECT_ROOT: '/tmp/realproj',
    });
    await client.connect(transport);

    // 1. Publish pair_list first.
    await expect(client.callTool({ name: 'mcp_tool_search', arguments: { query: 'pair_list' } }))
      .resolves.toMatchObject({ structuredContent: { status: 'ok', published: ['pair_list'] } });
    await waitFor(async () => ((await client.listTools()).tools.some((t) => t.name === 'pair_list') ? true : undefined), 8_000);

    // 2. Replacing via fallbackCall where target tool returns a business error (no daemon hook port -> status: 'error')
    //    still updates the backend's published selection to session_identity_get.
    const fallbackErrRes = await client.callTool({
      name: 'mcp_tool_search',
      arguments: { query: 'session_identity_get', fallbackCall: { name: 'session_identity_get', arguments: {} } },
    });
    expect(fallbackErrRes).toMatchObject({ structuredContent: { status: 'error' } });

    // 3. Reap idle generation 1, then trigger generation 2; backend should publish session_identity_get, NOT stale pair_list.
    await waitFor(async () => ((await readFile(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8').catch(() => '')).includes('"idle_timeout"') ? true : undefined), 8_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await client.callTool({ name: 'session_identity_get', arguments: {} });
    const gen2Tools = (await client.listTools()).tools.map((t) => t.name);
    expect(gen2Tools).toContain('session_identity_get');
    expect(gen2Tools).not.toContain('pair_list');

    // 4. An ordinary unmatched search with activate=true clears the published tail on backend.
    await expect(client.callTool({ name: 'mcp_tool_search', arguments: { query: 'totally_missing_tool_xyz_123' } }))
      .resolves.toMatchObject({ structuredContent: { status: 'ok', published: [] } });

    // Reap generation 2, respawn generation 3, confirm cleared tail stays empty (session_identity_get NOT resurrected).
    await waitFor(async () => {
      const log = await readFile(join(home, 'logs', 'mcp-lifecycle.log'), 'utf8').catch(() => '');
      return log.split('"idle_timeout"').length >= 3 ? true : undefined;
    }, 8_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await client.callTool({ name: 'memory_injection_get', arguments: {} }).catch(() => {});
    const gen3Tools = (await client.listTools()).tools.map((t) => t.name);
    expect(gen3Tools).not.toContain('session_identity_get');
  }, 60_000);

  it('bounds discovery metadata cleanly on queue-full and deterministic caller-env failures', async () => {
    const { child, messages } = rawBootstrap({
      IMCODES_MCP_TOOL_CATALOG_MODE: 'dynamic',
      IMCODES_MEMORY_MCP_TEST_CALLER_ENV_ERROR: 'deterministic bad env',
      IMCODES_MEMORY_MCP_TEST_DELAY_MS: '500',
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bound-test', version: '1' } },
    })}\n`);
    await waitFor(() => messages.find((m) => m.id === 1));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    // Burst 80 activating mcp_tool_search calls (> MAX_QUEUED_REQUESTS=64) while backend startup fails deterministically.
    for (let i = 100; i < 180; i += 1) {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: i, method: 'tools/call',
        params: { name: 'mcp_tool_search', arguments: { query: `tool_${i}` } },
      })}\n`);
    }

    await waitFor(() => (messages.filter((m) => typeof m.id === 'number' && m.id >= 100).length === 80 ? true : undefined), 10_000);
    const replies = messages.filter((m) => typeof m.id === 'number' && m.id >= 100);
    const queueFullCount = replies.filter((m) => (m.error as { code?: number; message?: string } | undefined)?.message === 'memory_mcp_backend_queue_full').length;
    const fatalCount = replies.filter((m) => (m.error as { code?: number; message?: string } | undefined)?.code === -32004).length;
    expect(queueFullCount).toBe(16);
    expect(fatalCount).toBe(64);

    // Further calls after deterministic failure fail immediately and never replay prior discovery queries.
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 999, method: 'tools/call',
      params: { name: 'mcp_tool_search', arguments: { query: 'post_fatal' } },
    })}\n`);
    const lateReply = await waitFor(() => messages.find((m) => m.id === 999));
    expect(lateReply).toMatchObject({ error: { code: -32004 } });
  }, 15_000);
});
