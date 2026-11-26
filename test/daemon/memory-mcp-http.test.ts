import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const readSenderParticipantTurnMock = vi.hoisted(() => vi.fn(() => null));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
  loadStore: vi.fn(),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(() => ({})), on: vi.fn() },
}));

vi.mock('../../src/daemon/sender-participant-turn.js', () => ({
  AMBIGUOUS_PARTICIPANT_ACTOR: '__ambiguous_participant__',
  readSenderParticipantTurn: readSenderParticipantTurnMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { closeHookServer, getActiveHookServerPort, startHookServer } from '../../src/daemon/hook-server.js';
import { createMemoryMcpHttpHandler, MEMORY_MCP_HTTP_HEADERS, MEMORY_MCP_HTTP_PATH } from '../../src/daemon/memory-mcp-http.js';
import { HOOK_SESSION_CREDENTIAL_HEADER } from '../../shared/hook-session-credential.js';
import { buildCodexMcpThreadConfig } from '../../src/agent/providers/codex-sdk.js';
import { getCodexAppServerArgs } from '../../src/agent/providers/getDefaultCodexMcpArgs.js';

function rawHttpRequest(options: {
  port: number;
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const data = options.body ?? '';
    const req = http.request({
      agent: false,
      hostname: '127.0.0.1',
      port: options.port,
      path: options.path ?? MEMORY_MCP_HTTP_PATH,
      method: options.method,
      headers: {
        ...(data ? { 'Content-Length': String(Buffer.byteLength(data)) } : {}),
        ...(options.headers ?? {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('memory MCP Streamable HTTP endpoint (/mcp)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    readSenderParticipantTurnMock.mockReset();
    readSenderParticipantTurnMock.mockReturnValue(null);
    getSessionMock.mockReset();
    await Promise.allSettled(cleanups.splice(0).map((fn) => fn()));
  });

  it('serves multiple concurrent Codex sessions over /mcp and restores stdio fallback on close', async () => {
    const sessions = new Map<string, Record<string, unknown>>([
      ['deck_alpha_w1', {
        name: 'deck_alpha_w1',
        projectName: 'alpha',
        projectDir: '/tmp/alpha',
        agentType: 'codex-sdk',
        providerId: 'codex-sdk',
        state: 'running',
        sessionInstanceId: 'inst-alpha',
        runtimeEpoch: 'epoch-alpha',
        contextNamespace: { scope: 'user_private', userId: 'user-alpha' },
      }],
      ['deck_beta_w2', {
        name: 'deck_beta_w2',
        projectName: 'beta',
        projectDir: '/tmp/beta',
        agentType: 'codex-sdk',
        providerId: 'codex-sdk',
        state: 'idle',
        sessionInstanceId: 'inst-beta',
        runtimeEpoch: 'epoch-beta',
        contextNamespace: { scope: 'user_private', userId: 'user-beta' },
      }],
    ]);
    getSessionMock.mockImplementation((name: string) => sessions.get(name));

    const calls: Array<{ sessionName: string | null; userId: string; transport: string; tool: string; input: unknown }> = [];
    const { server, port } = await startHookServer(() => {}, {
      memoryMcpServerId: 'srv-local',
      invokeMemoryMcpTool: async (caller, tool, input) => {
        calls.push({
          sessionName: caller.sessionName,
          userId: caller.userId,
          transport: caller.transport,
          tool,
          input,
        });
        return { status: 'ok', hits: [], session: caller.sessionName, user: caller.userId };
      },
    });
    cleanups.push(async () => {
      await closeHookServer(server).catch(() => {});
    });

    expect(getActiveHookServerPort()).toBe(port);

    // Codex config uses /mcp HTTP and omits process-level command/args while hook server is live.
    const codexThreadCfg = buildCodexMcpThreadConfig({
      sessionKey: 'k-alpha',
      sessionName: 'deck_alpha_w1',
      sessionInstanceId: 'inst-alpha',
      serverId: 'srv-local',
      cwd: '/tmp/alpha',
    } as never) as Record<string, any>;
    expect(codexThreadCfg.mcp_servers['imcodes-memory']).toMatchObject({
      url: `http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`,
      http_headers: {
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_alpha_w1',
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-alpha',
        [MEMORY_MCP_HTTP_HEADERS.SERVER_ID]: 'srv-local',
      },
    });
    expect(codexThreadCfg.mcp_servers['imcodes-memory'].command).toBeUndefined();
    expect(getCodexAppServerArgs().some((arg) => arg.includes('mcp_servers'))).toBe(false);

    // Connect two concurrent StreamableHTTP clients through the single daemon endpoint.
    const transportA = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_alpha_w1',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-alpha',
        },
      },
    });
    const clientA = new Client({ name: 'codex-a', version: '1' });

    const transportB = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_beta_w2',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-beta',
        },
      },
    });
    const clientB = new Client({ name: 'codex-b', version: '1' });

    cleanups.unshift(async () => {
      await Promise.allSettled([clientA.close(), clientB.close()]);
    });

    await Promise.all([clientA.connect(transportA), clientB.connect(transportB)]);
    expect(transportA.sessionId).toBeTruthy();
    expect(transportB.sessionId).toBeTruthy();
    expect(transportA.sessionId).not.toBe(transportB.sessionId);

    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
    expect(toolsA.tools.some((t) => t.name === 'search_memory')).toBe(true);
    expect(toolsB.tools.some((t) => t.name === 'mcp_tool_search')).toBe(true);

    // Concurrent calls preserve per-session identity with zero cross-contamination.
    const [resA, resB] = await Promise.all([
      clientA.callTool({ name: 'search_memory', arguments: { query: 'alpha-q' } }),
      clientB.callTool({ name: 'search_memory', arguments: { query: 'beta-q' } }),
    ]);
    expect(resA).toMatchObject({ structuredContent: { status: 'ok', session: 'deck_alpha_w1', user: 'user-alpha' } });
    expect(resB).toMatchObject({ structuredContent: { status: 'ok', session: 'deck_beta_w2', user: 'user-beta' } });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionName: 'deck_alpha_w1', userId: 'user-alpha', transport: 'streamable_http', tool: 'search_memory' }),
      expect.objectContaining({ sessionName: 'deck_beta_w2', userId: 'user-beta', transport: 'streamable_http', tool: 'search_memory' }),
    ]));

    // Cross-session mcp-session-id reuse must fail closed.
    const hijack = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_beta_w2',
        'mcp-session-id': transportA.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(hijack.status).toBe(403);
    expect(JSON.parse(hijack.body)).toMatchObject({ error: 'memory_mcp_http_session_mismatch' });

    // Shared participant turn: save_preference is refused and save_observation scopes to participant actor.
    readSenderParticipantTurnMock.mockImplementation((name: string) => (
      name === 'deck_alpha_w1' ? { actorUserId: 'participant-9', authority: 'auth-tok' } : null
    ));
    const prefRefused = await clientA.callTool({ name: 'save_preference', arguments: { text: 'should be blocked' } });
    expect(prefRefused).toMatchObject({
      structuredContent: { status: 'error', reason: 'scope_forbidden' },
    });
    const obsRes = await clientA.callTool({ name: 'save_observation', arguments: { content: 'participant note' } });
    expect(obsRes).toMatchObject({
      structuredContent: { status: 'ok', session: 'deck_alpha_w1', user: 'participant-9' },
    });

    // DELETE terminates only that MCP session.
    const del = await rawHttpRequest({
      port,
      method: 'DELETE',
      headers: {
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_alpha_w1',
        'mcp-session-id': transportA.sessionId!,
      },
    });
    expect(del.status).toBe(200);

    const afterDelete = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_alpha_w1',
        'mcp-session-id': transportA.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
    });
    expect(afterDelete.status).toBe(404);

    // Closing the hook server clears active live port and restores stdio fallback.
    await closeHookServer(server);
    expect(getActiveHookServerPort()).toBeNull();
    expect(getCodexAppServerArgs().some((arg) => arg.includes('mcp_servers.imcodes-memory.command'))).toBe(true);
  });

  it('enforces local guard, credential, stopped/incognito/instance checks, and rejects malformed requests cleanly', async () => {
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_stopped') return { name, state: 'stopped', projectName: 'p', projectDir: '/tmp/p', agentType: 'codex-sdk' };
      if (name === 'deck_incog') return { name, state: 'idle', incognito: true, projectName: 'p', projectDir: '/tmp/p', agentType: 'codex-sdk' };
      if (name === 'deck_cred') {
        return {
          name,
          state: 'idle',
          projectName: 'p',
          projectDir: '/tmp/p',
          agentType: 'codex-sdk',
          sessionInstanceId: 'inst-cred',
          hookCredential: 'secret-cred-123',
        };
      }
      return undefined;
    });

    const { server, port } = await startHookServer(() => {}, {
      invokeMemoryMcpTool: async () => ({ status: 'ok' }),
    });
    cleanups.push(() => closeHookServer(server).catch(() => {}));

    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
    });
    const baseHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    // Browser Origin rejected.
    expect((await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, Origin: 'https://evil.example', [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123' },
      body: initBody,
    })).status).toBe(403);

    // Unsupported method rejected with 405.
    expect((await rawHttpRequest({ port, method: 'PUT' })).status).toBe(405);

    // Missing / stopped / incognito session rejected.
    expect((await rawHttpRequest({ port, method: 'POST', headers: baseHeaders, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_stopped' }, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_incog' }, body: initBody })).status).toBe(403);

    // Missing or wrong hook credential rejected.
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred' }, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'wrong' }, body: initBody })).status).toBe(403);

    // Stale sessionInstanceId rejected with 409.
    expect((await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-stale' },
      body: initBody,
    })).status).toBe(409);

    // Unknown mcp-session-id returns 404, non-init without session returns 400.
    expect((await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123', 'mcp-session-id': 'does-not-exist' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })).status).toBe(404);
    expect((await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })).status).toBe(400);
  });

  it('executes real daemon tools (session_runtime_identity_get / pair_list) via default in-process invoker', async () => {
    const liveSession = {
      name: 'deck_real_w1',
      projectName: 'realproj',
      projectDir: '/tmp/realproj',
      agentType: 'codex-sdk',
      providerId: 'codex-sdk',
      state: 'idle',
      sessionInstanceId: 'inst-real-1',
      runtimeEpoch: 'epoch-real-1',
      requestedModel: 'gpt-5',
      activeModel: 'gpt-5',
    };
    getSessionMock.mockImplementation((name: string) => (name === 'deck_real_w1' ? liveSession : undefined));
    listSessionsMock.mockReturnValue([liveSession]);

    const { server, port } = await startHookServer(() => {});
    cleanups.push(() => closeHookServer(server).catch(() => {}));

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_real_w1',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-real-1',
        },
      },
    });
    const client = new Client({ name: 'real-invoker-client', version: '1' });
    cleanups.unshift(() => client.close().catch(() => {}));
    await client.connect(transport);

    const identityRes = await client.callTool({ name: 'session_runtime_identity_get', arguments: {} });
    expect(identityRes).toMatchObject({
      isError: false,
      structuredContent: {
        status: 'ok',
        identity: {
          sessionName: 'deck_real_w1',
          sessionInstanceId: 'inst-real-1',
          runtimeEpoch: 'epoch-real-1',
        },
      },
    });

    const pairRes = await client.callTool({ name: 'pair_list', arguments: {} });
    expect(pairRes).toMatchObject({
      isError: false,
      structuredContent: { status: 'ok' },
    });
  });

  it('evicts idle HTTP MCP sessions via TTL sweep', async () => {
    getSessionMock.mockImplementation((name: string) => ({
      name,
      state: 'idle',
      projectName: 'ttl',
      projectDir: '/tmp/ttl',
      agentType: 'codex-sdk',
      sessionInstanceId: 'inst-ttl',
      runtimeEpoch: 'epoch-ttl',
    }));

    let fakeNow = 1_000;
    const handler = createMemoryMcpHttpHandler({
      port: () => 51999,
      invokeMemoryMcpTool: async () => ({ status: 'ok' }),
      idleTtlMs: 100,
      sweepIntervalMs: 25,
      now: () => fakeNow,
    });
    const srv = http.createServer((req, res) => { void handler.handleRequest(req, res); });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    cleanups.push(async () => {
      await handler.closeAll();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: { headers: { [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_ttl_w1' } },
    });
    const client = new Client({ name: 'ttl-client', version: '1' });
    cleanups.unshift(() => client.close().catch(() => {}));
    await client.connect(transport);
    expect(handler.getSessionCount()).toBe(1);

    // Wait for StreamableHTTPClientTransport's post-connect GET SSE request to arrive before advancing fakeNow.
    await new Promise((resolve) => setTimeout(resolve, 40));
    fakeNow += 250;
    await vi.waitFor(() => {
      expect(handler.getSessionCount()).toBe(0);
    }, { timeout: 2_000, interval: 20 });
    srv.closeAllConnections?.();
  });
});
