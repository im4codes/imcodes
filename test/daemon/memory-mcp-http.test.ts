import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { HOOK_SESSION_CREDENTIAL_ERROR, HOOK_SESSION_CREDENTIAL_HEADER } from '../../shared/hook-session-credential.js';
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

  const tempAuthorityHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-mcp-http-home-'));
    cleanups.push(async () => {
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  };

  const listenEphemeral = (srv: http.Server): Promise<void> => new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    srv.once('error', onError);
    srv.listen(0, '127.0.0.1', () => {
      srv.removeListener('error', onError);
      resolve();
    });
  });

  afterEach(async () => {
    readSenderParticipantTurnMock.mockReset();
    readSenderParticipantTurnMock.mockReturnValue(null);
    getSessionMock.mockReset();
    listSessionsMock.mockReset();
    listSessionsMock.mockReturnValue([]);
    await Promise.allSettled(cleanups.splice(0).map((fn) => fn()));
  });

  it('serves multiple concurrent Codex sessions over /mcp and restores stdio fallback on close', async () => {
    const authorityHome = tempAuthorityHome();
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
        hookCredential: 'cred-alpha-1',
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
        hookCredential: 'cred-beta-1',
        contextNamespace: { scope: 'user_private', userId: 'user-beta' },
      }],
    ]);
    getSessionMock.mockImplementation((name: string) => sessions.get(name));

    const calls: Array<{ sessionName: string | null; userId: string; transport: string; tool: string; input: unknown }> = [];
    const { server, port } = await startHookServer(() => {}, {
      authorityHome,
      bindListener: listenEphemeral,
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
      env: { IMCODES_HOOK_SESSION_CREDENTIAL: 'cred-alpha-1' },
    } as never) as Record<string, any>;
    expect(codexThreadCfg.mcp_servers['imcodes-memory']).toMatchObject({
      url: `http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`,
      http_headers: {
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_alpha_w1',
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-alpha',
        [MEMORY_MCP_HTTP_HEADERS.SERVER_ID]: 'srv-local',
        [MEMORY_MCP_HTTP_HEADERS.HOOK_CREDENTIAL]: 'cred-alpha-1',
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
          [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-alpha-1',
        },
      },
    });
    const clientA = new Client({ name: 'codex-a', version: '1' });

    const transportB = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_beta_w2',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-beta',
          [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-beta-1',
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

    // Cross-session mcp-session-id reuse must fail closed even with Beta's own valid credential & instance headers.
    const hijack = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_beta_w2',
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-beta',
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-beta-1',
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
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-alpha',
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-alpha-1',
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
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-alpha',
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-alpha-1',
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

  it('enforces local guard, mandatory credential & instance binding, rotation invalidation, and stopped/incognito checks', async () => {
    const authorityHome = tempAuthorityHome();
    let credValue = 'secret-cred-123';
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_stopped') return { name, state: 'stopped', projectName: 'p', projectDir: '/tmp/p', agentType: 'codex-sdk', sessionInstanceId: 'inst-s', hookCredential: 'cred-s' };
      if (name === 'deck_incog') return { name, state: 'idle', incognito: true, projectName: 'p', projectDir: '/tmp/p', agentType: 'codex-sdk', sessionInstanceId: 'inst-i', hookCredential: 'cred-i' };
      if (name === 'deck_nocred') return { name, state: 'idle', projectName: 'p', projectDir: '/tmp/p', agentType: 'codex-sdk', sessionInstanceId: 'inst-nc' };
      if (name === 'deck_noinst') return { name, state: 'idle', projectName: 'p', projectDir: '/tmp/p', agentType: 'codex-sdk', hookCredential: 'cred-ni' };
      if (name === 'deck_cred') {
        return {
          name,
          state: 'idle',
          projectName: 'p',
          projectDir: '/tmp/p',
          agentType: 'codex-sdk',
          sessionInstanceId: 'inst-cred',
          hookCredential: credValue,
        };
      }
      return undefined;
    });

    const { server, port } = await startHookServer(() => {}, {
      authorityHome,
      bindListener: listenEphemeral,
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
      headers: { ...baseHeaders, Origin: 'https://evil.example', [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123' },
      body: initBody,
    })).status).toBe(403);

    // Unsupported method rejected with 405.
    expect((await rawHttpRequest({ port, method: 'PUT' })).status).toBe(405);

    // Missing / stopped / incognito / no-stored-credential / no-stored-instance rejected.
    expect((await rawHttpRequest({ port, method: 'POST', headers: baseHeaders, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_stopped', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-s', [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-s' }, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_incog', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-i', [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-i' }, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_nocred', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-nc' }, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_noinst', [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-ni' }, body: initBody })).status).toBe(403);

    // Missing or wrong hook credential rejected.
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred' }, body: initBody })).status).toBe(403);
    expect((await rawHttpRequest({ port, method: 'POST', headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'wrong' }, body: initBody })).status).toBe(403);

    // Missing or stale sessionInstanceId rejected strictly.
    const missingInst = await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123' },
      body: initBody,
    });
    expect(missingInst.status).toBe(403);
    expect((await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-stale' },
      body: initBody,
    })).status).toBe(409);

    // Unknown mcp-session-id returns 404, non-init without session returns 400.
    expect((await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123', 'mcp-session-id': 'does-not-exist' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })).status).toBe(404);
    expect((await rawHttpRequest({
      port, method: 'POST',
      headers: { ...baseHeaders, [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred', [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred', [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })).status).toBe(400);

    // Credential rotation invalidates existing active MCP session on next call.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred',
          [HOOK_SESSION_CREDENTIAL_HEADER]: 'secret-cred-123',
        },
      },
    });
    const client = new Client({ name: 'cred-rotate-client', version: '1' });
    cleanups.unshift(() => client.close().catch(() => {}));
    await client.connect(transport);
    credValue = 'rotated-cred-456';
    const rotated = await rawHttpRequest({
      port, method: 'POST',
      headers: {
        ...baseHeaders,
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred',
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred',
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'rotated-cred-456',
        'mcp-session-id': transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    expect(rotated.status).toBe(403);
    expect(JSON.parse(rotated.body)).toMatchObject({ error: HOOK_SESSION_CREDENTIAL_ERROR });
    // Old MCP session was closed on credential rotation; reusing it now returns 404.
    const staleAfterRotate = await rawHttpRequest({
      port, method: 'POST',
      headers: {
        ...baseHeaders,
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cred',
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-cred',
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'rotated-cred-456',
        'mcp-session-id': transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    });
    expect(staleAfterRotate.status).toBe(404);
  });

  it('executes real daemon tools and secondary loopback-hook-forwarded tools (session_model) with mandatory hook credential', async () => {
    const authorityHome = tempAuthorityHome();
    const liveSession = {
      name: 'deck_real_w1',
      projectName: 'realproj',
      projectDir: '/tmp/realproj',
      agentType: 'codex-sdk',
      providerId: 'codex-sdk',
      state: 'idle',
      sessionInstanceId: 'inst-real-1',
      runtimeEpoch: 'epoch-real-1',
      hookCredential: 'cred-real-1',
      requestedModel: 'gpt-5',
      activeModel: 'gpt-5',
    };
    getSessionMock.mockImplementation((name: string) => (name === 'deck_real_w1' ? liveSession : undefined));
    listSessionsMock.mockReturnValue([liveSession]);

    const listSessionModels = vi.fn(async (sessionName: string) => ({
      ok: true as const,
      sessionName,
      agentType: 'codex-sdk',
      currentModel: 'gpt-5',
      models: ['gpt-5', 'gpt-5-mini'],
      acceptsAnyModel: false,
    }));
    const { server, port } = await startHookServer(() => {}, {
      authorityHome,
      bindListener: listenEphemeral,
      listSessionModels,
      switchSessionModel: vi.fn(),
    });
    cleanups.push(() => closeHookServer(server).catch(() => {}));

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_real_w1',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-real-1',
          [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-real-1',
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

    // Secondary loopback hook call must authenticate via the session's bound hookCredential rather than failing 403.
    const modelRes = await client.callTool({ name: 'session_model', arguments: {} });
    expect(modelRes).toMatchObject({
      isError: false,
      structuredContent: { status: 'ok', sessionName: 'deck_real_w1', currentModel: 'gpt-5' },
    });
    expect(listSessionModels).toHaveBeenCalledWith('deck_real_w1');
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
      hookCredential: 'cred-ttl',
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
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_ttl_w1',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-ttl',
          [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-ttl',
        },
      },
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

  it('rebinds listener with active HTTP MCP SSE streams cleanly without entering shutdown state', async () => {
    const authorityHome = tempAuthorityHome();
    getSessionMock.mockImplementation((name: string) => ({
      name,
      state: 'idle',
      projectName: 'rebind',
      projectDir: '/tmp/rebind',
      agentType: 'codex-sdk',
      sessionInstanceId: 'inst-rebind',
      runtimeEpoch: 'epoch-rebind',
      hookCredential: 'cred-rebind',
    }));

    const { server, port: port1 } = await startHookServer(() => {}, {
      authorityHome,
      bindListener: listenEphemeral,
      rebindOnListenerLoss: true,
      invokeMemoryMcpTool: async (caller) => ({ status: 'ok', session: caller.sessionName }),
    });
    cleanups.push(() => closeHookServer(server).catch(() => {}));

    const transport1 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port1}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_rebind_w1',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-rebind',
          [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-rebind',
        },
      },
    });
    const client1 = new Client({ name: 'rebind-1', version: '1' });
    cleanups.unshift(() => client1.close().catch(() => {}));
    await client1.connect(transport1);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Trigger listener rebind while client1 SSE stream is open.
    server.emit('error', new Error('simulated listener loss during SSE'));
    let port2: number | null = null;
    await vi.waitFor(() => {
      const current = getActiveHookServerPort();
      expect(current).not.toBeNull();
      expect(current).not.toBe(port1);
      port2 = current;
    }, { timeout: 3_000, interval: 25 });

    // Handler stays active (not closingAll=true 503) and accepts fresh HTTP MCP clients on the new port.
    const transport2 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port2!}${MEMORY_MCP_HTTP_PATH}`), {
      requestInit: {
        headers: {
          [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_rebind_w1',
          [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-rebind',
          [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-rebind',
        },
      },
    });
    const client2 = new Client({ name: 'rebind-2', version: '1' });
    cleanups.unshift(() => client2.close().catch(() => {}));
    await client2.connect(transport2);
    const callRes = await client2.callTool({ name: 'search_memory', arguments: { query: 'post-rebind' } });
    expect(callRes).toMatchObject({ structuredContent: { status: 'ok', session: 'deck_rebind_w1' } });
  });

  it('bounds maxSessions including pending initialize admissions, shields in-flight POSTs from TTL, and blocks reset/close registration races', async () => {
    getSessionMock.mockImplementation((name: string) => ({
      name,
      state: 'idle',
      projectName: 'bound',
      projectDir: '/tmp/bound',
      agentType: 'codex-sdk',
      sessionInstanceId: `inst-${name}`,
      runtimeEpoch: `epoch-${name}`,
      hookCredential: `cred-${name}`,
    }));

    let fakeNow = 10_000;
    let releaseSlowPost!: () => void;
    let enteredSlowPost!: () => void;
    const slowPostStarted = new Promise<void>((resolve) => { enteredSlowPost = resolve; });
    const slowPostGate = new Promise<void>((resolve) => { releaseSlowPost = resolve; });

    const handler = createMemoryMcpHttpHandler({
      port: () => 51999,
      invokeMemoryMcpTool: async (_caller, tool, input) => {
        if (tool === 'search_memory' && (input as Record<string, unknown>).query === 'slow') {
          enteredSlowPost();
          await slowPostGate;
        }
        return { status: 'ok' };
      },
      idleTtlMs: 80,
      sweepIntervalMs: 20,
      maxSessions: 2,
      now: () => fakeNow,
    });
    const srv = http.createServer((req, res) => { void handler.handleRequest(req, res); });
    await listenEphemeral(srv);
    const port = (srv.address() as { port: number }).port;
    cleanups.push(async () => {
      releaseSlowPost?.();
      await handler.closeAll();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    });

    // 1. Bounded session admission: connect 2 sessions, 3rd returns 503 memory_mcp_http_capacity_exceeded.
    const connectClient = async (sessionName: string) => {
      const tr = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MEMORY_MCP_HTTP_PATH}`), {
        requestInit: {
          headers: {
            [MEMORY_MCP_HTTP_HEADERS.SESSION]: sessionName,
            [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: `inst-${sessionName}`,
            [HOOK_SESSION_CREDENTIAL_HEADER]: `cred-${sessionName}`,
          },
        },
      });
      const cl = new Client({ name: sessionName, version: '1' });
      cleanups.unshift(() => cl.close().catch(() => {}));
      await cl.connect(tr);
      return { tr, cl };
    };
    const c1 = await connectClient('deck_cap_1');
    const c2 = await connectClient('deck_cap_2');
    expect(handler.getSessionCount()).toBe(2);

    const overflow = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_cap_3',
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-deck_cap_3',
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-deck_cap_3',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cap-3', version: '1' } },
      }),
    });
    expect(overflow.status).toBe(503);
    expect(JSON.parse(overflow.body)).toMatchObject({ error: 'memory_mcp_http_capacity_exceeded' });

    // 2. Long in-flight POST on c1 is protected past idleTtlMs while c2 (idle with GET SSE) is reaped.
    const slowPromise = c1.cl.callTool({ name: 'search_memory', arguments: { query: 'slow' } });
    await slowPostStarted;
    fakeNow += 250;
    await vi.waitFor(() => {
      expect(handler.getSessionCount()).toBe(1);
    }, { timeout: 2_000, interval: 20 });
    releaseSlowPost();
    await expect(slowPromise).resolves.toMatchObject({ structuredContent: { status: 'ok' } });

    // Once POST settles, c1 also becomes eligible for TTL eviction despite GET SSE remaining connected.
    fakeNow += 250;
    await vi.waitFor(() => {
      expect(handler.getSessionCount()).toBe(0);
    }, { timeout: 2_000, interval: 20 });

    // 3. In-flight initialize body read aborted by resetSessions() cannot register late after resolve.
    const partialBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'race', version: '1' } },
    });
    const splitAt = Math.floor(partialBody.length / 2);
    let raceStatus = 0;
    const raceReq = http.request({
      agent: false,
      hostname: '127.0.0.1',
      port,
      path: MEMORY_MCP_HTTP_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': String(Buffer.byteLength(partialBody)),
        [MEMORY_MCP_HTTP_HEADERS.SESSION]: 'deck_race_1',
        [MEMORY_MCP_HTTP_HEADERS.SESSION_INSTANCE_ID]: 'inst-deck_race_1',
        [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-deck_race_1',
      },
    }, (res) => {
      raceStatus = res.statusCode ?? 0;
      res.resume();
    });
    raceReq.on('error', () => {});
    raceReq.write(partialBody.slice(0, splitAt));
    await new Promise((resolve) => setTimeout(resolve, 25));
    await handler.resetSessions();
    raceReq.end(partialBody.slice(splitAt));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(handler.getSessionCount()).toBe(0);
    expect([0, 503]).toContain(raceStatus);
    srv.closeAllConnections?.();
  });
});
