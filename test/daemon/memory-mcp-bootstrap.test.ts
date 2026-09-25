import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

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
  it('dispatches before the daemon CLI graph and serves initialize/catalog while backend import is delayed', async () => {
    const source = await readFile(resolve('src/index.ts'), 'utf8');
    expect(/^import .*commander/m.test(source)).toBe(false);
    expect(source.indexOf("import('./daemon/memory-mcp-bootstrap.js')"))
      .toBeLessThan(source.indexOf("import('./cli.js')"));

    const { client, transport } = connect({ IMCODES_MEMORY_MCP_TEST_DELAY_MS: '6000' });
    const startedAt = Date.now();
    await client.connect(transport);
    const initial = await client.listTools();
    // Source-mode includes the tsx loader; the shipped JS path is much faster.
    // This bound is still below the deliberately blocked backend and far below
    // the MCP clients' 30s CONNECT_TIMEOUT.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(initial.tools.some((tool) => tool.name === 'mcp_tool_search')).toBe(true);
    expect(initial.tools.length).toBeGreaterThan(35);

    await waitForFixtureCatalog(client);
    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'ready' } }))
      .resolves.toMatchObject({ structuredContent: { echoed: 'ready' } });
  }, 20_000);

  it('keeps stdio connected and automatically replaces a backend that crashes during startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-reconnect-'));
    const { client, transport, stderr } = connect({
      IMCODES_MEMORY_MCP_TEST_CRASH_MARKER: join(dir, 'crashed'),
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.some((tool) => tool.name === 'mcp_tool_search')).toBe(true);

    await waitForFixtureCatalog(client);
    expect(stderr.join('')).toContain('reconnecting automatically');
    await expect(client.callTool({ name: 'fixture_echo', arguments: { value: 'recovered' } }))
      .resolves.toMatchObject({ structuredContent: { echoed: 'recovered' } });
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
    const registryDir = join(home, 'session-resources');
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
    });
    expect(record.resourceId).toMatch(/^mcp-backend:epoch-backend-owned:/);
    expect(record.handle?.pid).not.toBe(transport.pid);
  }, 15_000);

  it('keeps increasing reconnect backoff while a ready backend flaps before the stable window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memory-mcp-flap-'));
    const startLog = join(dir, 'starts.log');
    const { client, transport } = connect({
      IMCODES_MEMORY_MCP_TEST_START_LOG: startLog,
      IMCODES_MEMORY_MCP_TEST_CRASH_AFTER_READY_MS: '20',
      IMCODES_MEMORY_MCP_TEST_STABLE_UPTIME_MS: '5000',
    });
    await client.connect(transport);
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
    await waitForFixtureCatalog(client);
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
    await waitFor(() => messages.find((message) => message.method === 'notifications/tools/list_changed'));

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
    await waitForFixtureCatalog(client);
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
    await waitForFixtureCatalog(client);
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
    await waitForFixtureCatalog(client);

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
});
