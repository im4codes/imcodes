import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import {
  MEMORY_MCP_SESSION_CLOSE_HOOK_PATH,
  MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH,
  MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH,
  MEMORY_MCP_SESSION_RESTART_BATCH_HOOK_PATH,
  MEMORY_MCP_SESSION_RESTART_HOOK_PATH,
} from '../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_DAEMON_RPC_PATH } from '../../shared/memory-mcp-daemon-rpc.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';

const participantTurns = new Set<string>();
const sessionsMap = new Map<string, { name: string; projectName: string; state: string }>();

vi.mock('../../src/daemon/sender-participant-turn.js', () => ({
  readSenderParticipantTurn: vi.fn((sessionName: string) => participantTurns.has(sessionName)),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn((name: string) => sessionsMap.get(name) ?? null),
  upsertSession: vi.fn(),
  listSessions: vi.fn(() => Array.from(sessionsMap.values())),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(() => undefined),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../src/context/memory-recall-client.js', () => ({
  searchLocalMemoryForManagement: vi.fn(async () => ({ items: [] })),
  searchLocalMemorySemanticForManagement: vi.fn(async () => ({ items: [] })),
}));
vi.mock('../../src/store/memory-daemon-switch.js', () => ({
  isMemoryDaemonEnabled: vi.fn(() => true),
}));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';
import { aliasMcpList, aliasMcpResolve } from '../../src/daemon/alias-mcp-client.js';
import { listVerificationMachineProfiles } from '../../src/daemon/verification-machine-mcp-client.js';
import { messagePinMcpList } from '../../src/daemon/message-pin-mcp-client.js';
import { cronMcpList } from '../../src/daemon/cron-mcp-client.js';
import { searchMcpMemoryRecall } from '../../src/daemon/memory-mcp-search.js';
import { getMemorySourcesOrchestrated } from '../../src/daemon/memory-get-sources-orchestrator.js';
import { ServerCapabilityService } from '../../src/capability/server-capability-service.js';

function requestHook(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  sender?: string,
  body?: unknown,
) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      agent: false,
      headers: {
        Connection: 'close',
        ...(body !== undefined
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {}),
        ...(sender ? { 'x-imcodes-session': sender } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(data);
    else req.end();
  });
}

describe('hook-server shared participant isolation', () => {
  let server: http.Server;
  let port: number;
  const invokeMemoryMcpTool = vi.fn(async () => ({ status: 'ok', entries: [] }));
  const closeSession = vi.fn(async () => ({
    status: 'closed' as const,
    target: 'deck_sub_other',
    authority: 'brain' as const,
    serverNotified: true,
    forced: false,
  }));
  const restartSession = vi.fn(async () => true);
  const listSessionModels = vi.fn(async () => ({
    status: 'ok' as const,
    target: 'deck_shared_main',
    currentModel: 'sonnet',
    currentThinking: 'medium',
    supportedModels: ['sonnet'],
    supportedThinking: ['medium'],
  }));
  const switchSessionModel = vi.fn(async () => ({
    status: 'ok' as const,
    target: 'deck_shared_main',
    model: 'sonnet',
  }));
  const onHook = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    participantTurns.clear();
    sessionsMap.clear();
    participantTurns.add('deck_shared_main');
    sessionsMap.set('deck_shared_main', { name: 'deck_shared_main', projectName: 'proj-shared', state: 'idle' });
    sessionsMap.set('deck_shared_sub', { name: 'deck_shared_sub', projectName: 'proj-shared', state: 'idle' });
    sessionsMap.set('deck_private_main', { name: 'deck_private_main', projectName: 'proj-private', state: 'idle' });

    const started = await startHookServer(onHook, {
      invokeMemoryMcpTool,
      closeSession,
      restartSession,
      listSessionModels,
      switchSessionModel,
    });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('denies MEMORY_MCP_DAEMON_RPC_PATH during participant turns without invoking tool handlers, while allowing owner turns', async () => {
    const blocked = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_shared_main', {
      tool: 'search_memory',
      input: { query: 'hello' },
    });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({
      ok: true,
      result: { status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN },
    });
    expect(invokeMemoryMcpTool).not.toHaveBeenCalled();

    const allowed = await requestHook(port, 'POST', MEMORY_MCP_DAEMON_RPC_PATH, 'deck_private_main', {
      tool: 'search_memory',
      input: { query: 'hello' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ ok: true, result: { status: 'ok' } });
    expect(invokeMemoryMcpTool).toHaveBeenCalledTimes(1);
  });

  it('blocks participant turns from switching models or reading models of other sessions, while allowing self read', async () => {
    const selfList = await requestHook(port, 'POST', MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_main',
    });
    expect(selfList.status).toBe(200);

    const otherList = await requestHook(port, 'POST', MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_private_main',
    });
    expect(otherList.status).toBe(403);
    expect(otherList.body.error).toBe('shared_participant_forbidden');

    const selfSet = await requestHook(port, 'POST', MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_main',
      model: 'opus',
    });
    expect(selfSet.status).toBe(403);
    expect(selfSet.body.error).toBe('shared_participant_forbidden');
    expect(switchSessionModel).not.toHaveBeenCalled();
  });

  it('blocks participant turns from resetting self, restarting other sessions, or closing sessions', async () => {
    const crossRestart = await requestHook(port, 'POST', MEMORY_MCP_SESSION_RESTART_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_private_main',
      reset: false,
    });
    expect(crossRestart.status).toBe(403);
    expect(crossRestart.body.error).toBe('shared_participant_forbidden');

    const resetSelf = await requestHook(port, 'POST', MEMORY_MCP_SESSION_RESTART_BATCH_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      targets: [{ target: 'deck_shared_main', reset: true }],
    });
    expect(resetSelf.status).toBe(403);
    expect(resetSelf.body.error).toBe('shared_participant_forbidden');

    const selfSoftRestart = await requestHook(port, 'POST', MEMORY_MCP_SESSION_RESTART_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_main',
      reset: false,
    });
    expect(selfSoftRestart.status).toBe(202);

    const closeRes = await requestHook(port, 'POST', MEMORY_MCP_SESSION_CLOSE_HOOK_PATH, 'deck_shared_main', {
      from: 'deck_shared_main',
      target: 'deck_shared_sub',
    });
    expect(closeRes.status).toBe(403);
    expect(closeRes.body.error).toBe('shared_participant_forbidden');
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('blocks participant turns from /stop or /send /stop on sibling sessions', async () => {
    const stopRes = await requestHook(port, 'POST', '/stop', 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_sub',
    });
    expect(stopRes.status).toBe(403);
    expect(stopRes.body.error).toBe('shared_participant_forbidden');

    const sendStopRes = await requestHook(port, 'POST', '/send', 'deck_shared_main', {
      from: 'deck_shared_main',
      to: 'deck_shared_sub',
      message: '/stop',
    });
    expect(sendStopRes.status).toBe(403);
    expect(sendStopRes.body.error).toBe('shared_participant_forbidden');
  });

  it('scopes /sessions/live to caller projectName when x-imcodes-session resolves a session record', async () => {
    const scoped = await requestHook(port, 'POST', '/sessions/live', 'deck_shared_main', {});
    expect(scoped.status).toBe(200);
    expect((scoped.body.sessions as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'deck_shared_main',
      'deck_shared_sub',
    ]);

    const cliUnscoped = await requestHook(port, 'POST', '/sessions/live', undefined, {});
    expect(cliUnscoped.status).toBe(200);
    expect((cliUnscoped.body.sessions as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'deck_shared_main',
      'deck_shared_sub',
      'deck_private_main',
    ]);
  });
});

describe('daemon MCP HTTP clients propagate shared-machine authority and fail closed on loader failure', () => {
  const endpoint = { serverId: 'srv_shared', workerUrl: 'http://127.0.0.1:9999', token: 'tok_secret' };

  function mockOkFetch() {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, items: [], pins: [], entries: [], capabilities: [], jobs: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  function extractHeader(fetchMock: ReturnType<typeof mockOkFetch>, name: string): string | null {
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | Headers | undefined;
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return null;
  }

  it('sends X-IMCodes-Shared-Machine-Authority across all daemon MCP HTTP clients when loaded', async () => {
    const authToken = 'sma.jwt.participant.token';
    const loader = async () => authToken;

    const fAlias = mockOkFetch();
    await aliasMcpList({ endpoint, fetchImpl: fAlias, loadSharedMachineAuthority: loader });
    expect(extractHeader(fAlias, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fAliasResolve = mockOkFetch();
    await aliasMcpResolve('deploy', { endpoint, fetchImpl: fAliasResolve, loadSharedMachineAuthority: loader });
    expect(extractHeader(fAliasResolve, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fVm = mockOkFetch();
    await listVerificationMachineProfiles(undefined, { endpoint, fetchImpl: fVm, loadSharedMachineAuthority: loader });
    expect(extractHeader(fVm, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fPins = mockOkFetch();
    await messagePinMcpList({}, { endpoint, fetchImpl: fPins, loadSharedMachineAuthority: loader });
    expect(extractHeader(fPins, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fCron = mockOkFetch();
    await cronMcpList({}, { endpoint, fetchImpl: fCron, loadSharedMachineAuthority: loader });
    expect(extractHeader(fCron, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fMem = mockOkFetch();
    await searchMcpMemoryRecall({
      query: 'hello',
      namespace: { scope: 'personal', projectId: 'proj' },
    }, { credentials: endpoint, fetchImpl: fMem, loadSharedMachineAuthority: loader });
    expect(extractHeader(fMem, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fSources = mockOkFetch();
    await getMemorySourcesOrchestrated('proj_1', {
      namespace: { scope: 'personal', projectId: 'proj' },
    }, {
      loadCredentials: async () => endpoint,
      fetchImpl: fSources,
      loadSharedMachineAuthority: loader,
    });
    expect(extractHeader(fSources, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);

    const fCap = mockOkFetch();
    const capSvc = new ServerCapabilityService({
      serverId: endpoint.serverId,
      loadCredentials: async () => endpoint,
      fetchImpl: fCap,
      loadSharedMachineAuthority: loader,
    });
    await capSvc.list({ scope: 'account' });
    expect(extractHeader(fCap, SHARED_MACHINE_AUTHORITY_HEADER)).toBe(authToken);
  });

  it('fails closed without issuing fetch when loadSharedMachineAuthority throws', async () => {
    const failingLoader = async () => {
      throw new Error('authority_lookup_failed');
    };
    const fetchNever = mockOkFetch();

    const r1 = await aliasMcpList({ endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r1).toMatchObject({ status: 'error' });

    const r2 = await listVerificationMachineProfiles(undefined, { endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r2).toMatchObject({ status: 'error' });

    const r3 = await messagePinMcpList({}, { endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r3).toMatchObject({ status: 'error' });

    const r4 = await cronMcpList({}, { endpoint, fetchImpl: fetchNever, loadSharedMachineAuthority: failingLoader });
    expect(r4).toMatchObject({ status: 'error' });

    const capSvc = new ServerCapabilityService({
      serverId: endpoint.serverId,
      loadCredentials: async () => endpoint,
      fetchImpl: fetchNever,
      loadSharedMachineAuthority: failingLoader,
    });
    const r5 = await capSvc.list({ scope: 'account' });
    expect(r5).toMatchObject({ status: 'error' });

    expect(fetchNever).not.toHaveBeenCalled();
  });
});
