import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import {
  WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON,
  WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT,
} from '../../shared/worker-session-snapshot.js';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockUpsertDbSession = vi.fn();
const mockUpdateSession = vi.fn();
const mockUpdateSubSession = vi.fn();
const mockGetDbSessionByName = vi.fn();
const mockGetSubSessionById = vi.fn();
const mockGetDbSessionsByServer = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const mockGetSubSessionsByServer = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const mockGetUserPref = vi.fn();
const mockSetUserPref = vi.fn();
const mockResolveHttpShareAccess = vi.fn();
const mockResolveHttpShareAccessForCoveredSession = vi.fn();
const mockResolveServerMemberAccessOrShareDeny = vi.fn();
const mockDbQueryOne = vi.fn();
const mockDbQuery = vi.fn(async () => []);
const mockDbExecute = vi.fn(async () => ({ changes: 1 }));
const sendToDaemonMock = vi.fn();
const countSharePendingCommandsForUserMock = vi.fn(() => 0);
const getActiveDispatchIdForSessionMock = vi.fn(() => 'dispatch-1');
const resolveSessionIdentityProjectKeyMock = vi.fn<(sessionName: string) => string | null>(() => null);
/**
 * PROJECT/SESSION identity now routes to the daemon over WS instead of the
 * content table (tsk_cd_identity_daemon_storage); these two mocks stand in
 * for WsBridge.isDaemonConnected()/sendSessionIdentityLocalRequest() for the
 * identity tests below. Defaults to "connected, echoes the write back" so
 * every OTHER test in this file (which never touches identity) is unaffected.
 */
const isDaemonConnectedMock = vi.fn(() => true);
const resolveSessionAgentTypeMock = vi.fn<(name: string) => Promise<string | null>>(async () => null);
const invalidateSessionAgentTypeCacheMock = vi.fn();
let sendSessionRestartCommandMock: ((frame: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>) | undefined;
const sendSessionIdentityLocalRequestMock = vi.fn(async (
  _requestId: string,
  payload: { op: 'get' | 'set' | 'delete'; scope: string; scopeKey: string; content?: string },
) => {
  if (payload.op === 'set') {
    return { status: 'ok', contentHash: 'daemon-hash', revision: 1, updatedAt: 1 };
  }
  if (payload.op === 'delete') return { status: 'ok' };
  return { status: 'ok' };
});
const mockDb = { queryOne: mockDbQueryOne, query: mockDbQuery, execute: mockDbExecute };

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/db/queries.js', () => ({
  getServerById: vi.fn(async () => ({ id: 'srv-1', user_id: 'owner-user' })),
  getDbSessionsByServer: (...args: unknown[]) => mockGetDbSessionsByServer(...args),
  getDbSessionByName: (...args: unknown[]) => mockGetDbSessionByName(...args),
  getSubSessionById: (...args: unknown[]) => mockGetSubSessionById(...args),
  getSubSessionsByServer: (...args: unknown[]) => mockGetSubSessionsByServer(...args),
  getUserPref: (...args: unknown[]) => mockGetUserPref(...args),
  setUserPref: (...args: unknown[]) => mockSetUserPref(...args),
  upsertDbSession: (...args: unknown[]) => mockUpsertDbSession(...args),
  deleteDbSession: vi.fn(),
  updateSessionLabel: vi.fn(),
  updateProjectName: vi.fn(),
  updateSession: (...args: unknown[]) => mockUpdateSession(...args),
  updateSubSession: (...args: unknown[]) => mockUpdateSubSession(...args),
}));

vi.mock('../src/security/crypto.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/security/crypto.js')>(),
  randomHex: vi.fn(() => 'sid-test'),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: sendToDaemonMock,
      countSharePendingCommandsForUser: countSharePendingCommandsForUserMock,
      getActiveDispatchIdForSession: getActiveDispatchIdForSessionMock,
      resolveSessionIdentityProjectKey: resolveSessionIdentityProjectKeyMock,
      isDaemonConnected: isDaemonConnectedMock,
      sendSessionIdentityLocalRequest: sendSessionIdentityLocalRequestMock,
      resolveSessionAgentType: resolveSessionAgentTypeMock,
      invalidateSessionAgentTypeCache: invalidateSessionAgentTypeCacheMock,
      ...(sendSessionRestartCommandMock ? { sendSessionRestartCommand: sendSessionRestartCommandMock } : {}),
    }),
  },
}));

vi.mock('../src/routes/share-http-auth.js', () => ({
  resolveHttpShareAccess: (...args: unknown[]) => mockResolveHttpShareAccess(...args),
  resolveHttpShareAccessForCoveredSession: (...args: unknown[]) => mockResolveHttpShareAccessForCoveredSession(...args),
  resolveServerMemberAccessOrShareDeny: (...args: unknown[]) => mockResolveServerMemberAccessOrShareDeny(...args),
}));

vi.mock('../src/util/pod-identity.js', () => ({
  getPodIdentity: vi.fn(() => 'pod-a'),
}));

describe('session-mgmt persistence routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'owner',
      actor: { kind: 'server-member', effectiveActorRole: 'server-manager' },
    });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'server-member', effectiveActorRole: 'server-manager' },
    });
    mockGetDbSessionByName.mockResolvedValue(null);
    mockGetSubSessionById.mockResolvedValue(null);
    mockDbQueryOne.mockResolvedValue(null);
    mockDbQuery.mockResolvedValue([]);
    mockDbExecute.mockResolvedValue({ changes: 1 });
    countSharePendingCommandsForUserMock.mockReturnValue(0);
    getActiveDispatchIdForSessionMock.mockReturnValue('dispatch-1');
    mockGetDbSessionsByServer.mockResolvedValue([]);
    mockGetSubSessionsByServer.mockResolvedValue([]);
    resolveSessionAgentTypeMock.mockResolvedValue(null);
    mockGetUserPref.mockResolvedValue(null);
    mockSetUserPref.mockResolvedValue(undefined);
  });

  async function buildApp() {
    const { sessionMgmtRoutes } = await import('../src/routes/session-mgmt.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object; JWT_SIGNING_KEY: string } }).env = {
        DB: mockDb,
        JWT_SIGNING_KEY: 'session-mgmt-test-signing-key',
      };
      await next();
    });
    app.route('/api/server', sessionMgmtRoutes);
    return app;
  }

  it('GET /session-snapshot returns paired complete metadata for daemon sync', async () => {
    mockGetDbSessionsByServer.mockResolvedValueOnce([
      {
        name: 'deck_proj_brain',
        project_name: 'proj',
        role: 'brain',
        agent_type: 'claude-code',
        project_dir: '/tmp/proj',
        state: 'idle',
        label: null,
        requested_model: null,
        active_model: null,
        effort: null,
        transport_config: {},
      },
    ]);
    mockGetSubSessionsByServer.mockResolvedValueOnce([
      {
        id: 'child',
        type: 'claude-code',
        cwd: '/tmp/proj/sub',
        parent_session: 'deck_proj_brain',
        label: null,
        requested_model: null,
        active_model: null,
        effort: null,
        transport_config: {},
      },
    ]);
    const app = await buildApp();

    const res = await app.request(`/api/server/srv-1/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`);
    const body = await res.json() as {
      complete: boolean;
      serverId: string;
      counts: { sessions: number; subSessions: number };
      sessions: Array<{ name: string }>;
      subSessions: Array<{ id: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.complete).toBe(true);
    expect(body.serverId).toBe('srv-1');
    expect(body.counts).toEqual({ sessions: 1, subSessions: 1 });
    expect(body.sessions).toEqual([expect.objectContaining({ name: 'deck_proj_brain' })]);
    expect(body.subSessions).toEqual([expect.objectContaining({ id: 'child' })]);
  });

  it('GET /session-snapshot returns incomplete instead of complete empty when the query fails', async () => {
    mockGetDbSessionsByServer.mockRejectedValueOnce(new Error('db down'));
    const app = await buildApp();

    const res = await app.request(`/api/server/srv-1/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`);
    const body = await res.json() as { complete: boolean; reason: string };

    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      complete: false,
      reason: WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.QUERY_FAILED,
    });
  });

  it('GET /session-snapshot skips removed legacy gemini rows without 503 while still rejecting arbitrary invalid types', async () => {
    mockGetDbSessionsByServer.mockResolvedValueOnce([
      {
        name: 'deck_proj_brain',
        project_name: 'proj',
        role: 'brain',
        agent_type: 'claude-code-sdk',
        project_dir: '/tmp/proj',
        state: 'idle',
      },
      {
        name: 'deck_legacy_brain',
        project_name: 'legacy',
        role: 'brain',
        agent_type: 'gemini',
        project_dir: '/tmp/legacy',
        state: 'idle',
      },
    ]);
    mockGetSubSessionsByServer.mockResolvedValueOnce([
      {
        id: 'legacy-sub-1',
        type: 'gemini',
        cwd: '/tmp/legacy',
        parent_session: 'deck_proj_brain',
      },
      {
        id: 'legacy-sub-2',
        type: 'gemini-sdk',
        cwd: '/tmp/legacy',
        parent_session: 'deck_proj_brain',
      },
      {
        id: 'valid-sub-1',
        type: 'codex-sdk',
        cwd: '/tmp/proj/sub',
        parent_session: 'deck_proj_brain',
      },
    ]);
    const app = await buildApp();

    const okRes = await app.request(`/api/server/srv-1/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`);
    const okBody = await okRes.json() as {
      complete: boolean;
      counts: { sessions: number; subSessions: number };
      sessions: Array<{ name: string }>;
      subSessions: Array<{ id: string }>;
    };

    expect(okRes.status).toBe(200);
    expect(okBody.complete).toBe(true);
    expect(okBody.counts).toEqual({ sessions: 1, subSessions: 1 });
    expect(okBody.sessions.map((s) => s.name)).toEqual(['deck_proj_brain']);
    expect(okBody.subSessions.map((s) => s.id)).toEqual(['valid-sub-1']);

    mockGetDbSessionsByServer.mockResolvedValueOnce([]);
    mockGetSubSessionsByServer.mockResolvedValueOnce([
      { id: 'bogus-sub', type: 'totally-unknown', cwd: '/tmp/bogus' },
    ]);
    const badRes = await app.request(`/api/server/srv-1/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`);
    const badBody = await badRes.json() as { complete: boolean; reason: string };
    expect(badRes.status).toBe(503);
    expect(badBody).toMatchObject({
      complete: false,
      reason: WORKER_SESSION_SNAPSHOT_INCOMPLETE_REASON.INVALID_ROW,
    });
  });

  it('PUT /sessions/:name persists label plus requestedModel/activeModel/effort/transportConfig', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: 'proj',
        projectRole: 'brain',
        agentType: 'claude-code-sdk',
        projectDir: '/tmp/proj',
        state: 'idle',
        label: 'Readable Main',
        runtimeType: 'transport',
        providerId: 'claude-code-sdk',
        providerSessionId: 'route-1',
        description: 'persona',
        requestedModel: 'sonnet',
        activeModel: 'sonnet',
        effort: 'high',
        transportConfig: { provider: { mode: 'safe' } },
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpsertDbSession).toHaveBeenCalledWith(
      mockDb,
      'sid-test',
      'srv-1',
      'deck_proj_brain',
      'proj',
      'brain',
      'claude-code-sdk',
      '/tmp/proj',
      'idle',
      'Readable Main',
      null,
      'transport',
      'claude-code-sdk',
      'route-1',
      'persona',
      'sonnet',
      'sonnet',
      'high',
      { provider: { mode: 'safe' } },
      null,
    );
  });

  it('PUT /sessions/:name persists the service tier a node reports', async () => {
    // Codex keeps its "Fast" tier on the thread, so a session that came back on
    // it must survive the round trip to the database -- otherwise a viewer that
    // reconnects is told the session is on the ordinary tier and never sees the
    // warning that it is spending plan usage at 1.5x.
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: 'proj',
        projectRole: 'brain',
        agentType: 'codex-sdk',
        projectDir: '/tmp/proj',
        state: 'idle',
        serviceTier: 'priority',
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpsertDbSession.mock.calls.at(-1)?.at(-1)).toBe('priority');
  });

  it('PUT /sessions/:name ignores known test sessions', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_bootmainabc123_brain', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: 'bootmainabc123',
        projectRole: 'brain',
        agentType: 'claude-code-sdk',
        projectDir: '/tmp/bootmain-e2e',
        state: 'idle',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'test_session' });
    expect(mockUpsertDbSession).not.toHaveBeenCalled();
  });

  it('POST /session/start rejects known test sessions before relaying to daemon', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'bootmainabc123',
        dir: '/tmp/bootmain-e2e',
        agentType: 'claude-code-sdk',
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'test_session_blocked' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('PATCH /sessions/:name updates requestedModel/activeModel/effort/transportConfig', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestedModel: 'gpt-5.4',
        activeModel: 'gpt-5.4',
        effort: 'medium',
        transportConfig: { provider: { mode: 'balanced' } },
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      mockDb,
      'srv-1',
      'deck_proj_brain',
      {
        requested_model: 'gpt-5.4',
        active_model: 'gpt-5.4',
        effort: 'medium',
        transport_config: { provider: { mode: 'balanced' } },
      },
    );
  });

  it('PATCH /sessions/:name cannot bypass participant supervision read-only authority via transportConfig', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
          historyCutoffAt: 0,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-1'],
          primaryShareId: 'share-1',
          authorizedAt: Date.now(),
        },
      },
    });
    mockGetDbSessionByName.mockResolvedValue({
      name: 'deck_proj_brain',
      role: 'brain',
      agent_type: 'codex-sdk',
    });
    const app = await buildApp();

    const attemptedTransportConfigs = [
      null,
      {},
      { provider: { mode: 'partial' } },
      { supervision: null },
      ...(['off', 'supervised', 'supervised_audit'] as const).map((mode) => ({
        supervision: { mode },
      })),
    ];
    for (const transportConfig of attemptedTransportConfigs) {
      const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'must-not-mutate-either',
          transportConfig,
        }),
      });
      expect(res.status, JSON.stringify(transportConfig)).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    }

    expect(mockGetDbSessionByName).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(mockUpdateSubSession).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('PATCH /sessions/:name rejects cwd changes and shell/script agentType switches for single-session shares', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
          historyCutoffAt: 0,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-1'],
          primaryShareId: 'share-1',
          authorizedAt: Date.now(),
        },
      },
      shareProvenance: 'session',
    });
    const app = await buildApp();

    const cwdRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/etc' }),
    });
    expect(cwdRes.status).toBe(403);
    expect(await cwdRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    for (const agentType of ['shell', 'script']) {
      const typeRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType }),
      });
      expect(typeRes.status).toBe(200);
    }
    expect(mockUpdateSession).toHaveBeenCalledTimes(2);
  });

  it('PATCH /sessions/:name gives a whole-server participant the owner settings path with stamped provenance', async () => {
    const coverage = {
      target: { kind: 'server', serverId: 'srv-1' } as const,
      effectiveRole: 'participant' as const,
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['server-share-1'],
      primaryShareId: 'server-share-1',
      authorizedAt: Date.now(),
    };
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
      shareProvenance: 'server',
    });
    const app = await buildApp();
    const transportConfig = { provider: { mode: 'balanced' } };
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(mockDb, 'srv-1', 'deck_proj_brain', {
      transport_config: transportConfig,
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      type: 'session.update_transport_config',
      sessionName: 'deck_proj_brain',
      transportConfig,
      sharedActor: {
        origin: 'shared-server',
        snapshot: { target: coverage.target },
      },
    });
  });

  it('PATCH /sessions/:name relays session.restart when agentType changes', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'codex-sdk',
        cwd: '/tmp/next',
        description: 'next persona',
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      mockDb,
      'srv-1',
      'deck_proj_brain',
      {
        description: 'next persona',
        project_dir: '/tmp/next',
      },
    );
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.restart',
      sessionName: 'deck_proj_brain',
      agentType: 'codex-sdk',
      cwd: '/tmp/next',
      description: 'next persona',
    });
  });

  it('PATCH /sessions/:name rejects without updating DB when daemon restart preflight fails', async () => {
    const sendSessionRestartCommand = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Cannot safely forward model "bad" through unparsed Windows batch file',
    });
    sendSessionRestartCommandMock = sendSessionRestartCommand;
    try {
      const app = await buildApp();
      const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          requestedModel: 'm %TEMP%',
          ccPreset: 'CustomPreset',
        }),
      });

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: 'Cannot safely forward model "bad" through unparsed Windows batch file',
      });
      expect(sendSessionRestartCommand).toHaveBeenCalledTimes(1);
      expect(mockUpdateSession).not.toHaveBeenCalled();
    } finally {
      sendSessionRestartCommandMock = undefined;
    }
  });

  it('PATCH /sessions/:name commits daemon-applied fallback model (m1 instead of m2) and returns 202 when restart response is pending', async () => {
    const applied = {
      agentType: 'qwen',
      ccPreset: 'PresetA',
      requestedModel: 'm1',
      activeModel: 'm1',
      modelDisplay: 'm1',
      runtimeType: 'transport',
      providerId: 'qwen',
      cwd: '/tmp/proj',
      label: null,
      description: null,
      effort: null,
      transportConfig: null,
      runtimeEpoch: 'epoch-1',
    };
    sendSessionRestartCommandMock = vi.fn(async (_frame, opts?: { persistApplied?: (a: typeof applied) => Promise<void> }) => {
      await opts?.persistApplied?.(applied);
      return { status: 'committed' as const, applied };
    });
    try {
      const app = await buildApp();
      const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'qwen',
          ccPreset: 'PresetA',
          requestedModel: 'm2',
          activeModel: null,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, applied });
      expect(mockUpdateSession).toHaveBeenCalledWith(
        mockDb,
        'srv-1',
        'deck_proj_brain',
        expect.objectContaining({
          requested_model: 'm1',
          active_model: 'm1',
        }),
      );

      // Timeout/pending -> 202 (never 502) and does NOT overwrite DB with stale raw m2
      mockUpdateSession.mockClear();
      sendSessionRestartCommandMock = vi.fn(async () => ({
        status: 'pending' as const,
        requestId: 'req-pending-1',
        restartEpoch: 2,
      }));
      const pendingRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'qwen',
          ccPreset: 'PresetA',
          requestedModel: 'm2',
        }),
      });
      expect(pendingRes.status).toBe(202);
      expect(await pendingRes.json()).toEqual({ ok: false, pending: true, requestId: 'req-pending-1' });
      expect(mockUpdateSession).not.toHaveBeenCalled();

      // Superseded -> 200 { ok: false, superseded: true } without secondary persistApplied or raw updateSession fallback
      mockUpdateSession.mockClear();
      sendSessionRestartCommandMock = vi.fn(async () => ({ status: 'superseded' as const }));
      const supersededRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'qwen',
          ccPreset: null,
          requestedModel: 'stale-m',
        }),
      });
      expect(supersededRes.status).toBe(200);
      expect(await supersededRes.json()).toEqual({ ok: false, superseded: true });
      expect(mockUpdateSession).not.toHaveBeenCalled();

      // Plain agentType switch WITHOUT ccPreset bypasses confirmation protocol on modern daemon
      mockUpdateSession.mockClear();
      const plainSpy = vi.fn(async () => ({ status: 'committed' as const, applied }));
      sendSessionRestartCommandMock = plainSpy;
      const plainRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'codex-sdk',
          requestedModel: 'gpt-5',
        }),
      });
      expect(plainRes.status).toBe(200);
      expect(await plainRes.json()).toEqual({ ok: true });
      expect(plainSpy).not.toHaveBeenCalled();
      expect(mockUpdateSession).toHaveBeenCalledTimes(1);
      expect(sendToDaemonMock).toHaveBeenCalledWith(JSON.stringify({
        type: 'session.restart',
        sessionName: 'deck_proj_brain',
        agentType: 'codex-sdk',
        requestedModel: 'gpt-5',
      }));
    } finally {
      sendSessionRestartCommandMock = undefined;
    }
  });

  it('PATCH /sessions/:name relays transport-config updates to the daemon without a restart', async () => {
    const transportConfig = {
      supervision: {
        mode: 'supervised',
        backend: 'codex-sdk',
        model: 'gpt-5.6-sol',
        timeoutMs: 30_000,
        promptVersion: 'supervision_decision_v1',
        maxParseRetries: 1,
        maxAutoContinueStreak: 2,
        maxAutoContinueTotal: 0,
      },
    };
    mockGetDbSessionByName.mockResolvedValue({ name: 'deck_proj_brain', role: 'brain' });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transportConfig,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      mockDb,
      'srv-1',
      'deck_proj_brain',
      {
        transport_config: transportConfig,
      },
    );
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_proj_brain',
      transportConfig,
    });
  });

  it('PATCH /sessions/:name accepts targetless automatic audit routed by an explicit live pool', async () => {
    const transportConfig = {
      supervision: {
        mode: 'supervised_audit',
        backend: 'codex-sdk',
        model: 'gpt-5.6-sol',
        timeoutMs: 30_000,
        promptVersion: 'supervision_decision_v1',
        maxParseRetries: 1,
        maxAutoContinueStreak: 2,
        maxAutoContinueTotal: 0,
        maxAuditLoops: 2,
        taskRunPromptVersion: 'task_run_status_v1',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{
              capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
              agentType: 'codex-sdk',
              providerFamily: 'openai',
              runtimeType: 'transport',
              model: 'gpt-5.6-sol',
            }],
            controls: {},
          },
          economyTaskPool: { configs: [], controls: {} },
        },
      },
    };
    mockGetDbSessionByName.mockResolvedValue({ name: 'deck_proj_brain', role: 'brain' });
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalledWith(
      mockDb,
      'srv-1',
      'deck_proj_brain',
      { transport_config: transportConfig },
    );
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_proj_brain',
      transportConfig,
    });
  });

  it('PATCH /sessions/:name refuses automatic supervision for a non-Brain session', async () => {
    mockGetDbSessionByName.mockResolvedValue({ name: 'deck_proj_worker', role: 'w1' });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_worker', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transportConfig: {
          supervision: {
            mode: 'supervised',
            backend: 'codex-sdk',
            model: 'gpt-5.6-sol',
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
            maxParseRetries: 1,
            maxAutoContinueStreak: 2,
            maxAutoContinueTotal: 0,
          },
        },
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'brain_session_required' });
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('POST /session/cancel relays direct SDK cancel without /stop text', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_proj_brain', commandId: 'cancel-1', stopAndSendPendingMessageIds: ['queued-1'], text: '/stop' }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL,
      sessionName: 'deck_proj_brain',
      commandId: 'cancel-1', stopAndSendPendingMessageIds: ['queued-1'],
    });
  });

  it('POST /session/send strips forged share actor fields for ordinary member relays', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        text: 'hello',
        sharedActor: { actorUserId: 'spoofed' },
        shareScope: { target: { kind: 'server', serverId: 'srv-1' } },
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'hello',
    });
  });

  it('PATCH /sessions/:name/rename updates the project name and relays session.rename', async () => {
    const { updateProjectName } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-proj' }),
    });

    expect(res.status).toBe(200);
    expect(updateProjectName).toHaveBeenCalledWith(mockDb, 'srv-1', 'deck_proj_brain', 'new-proj');
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.rename',
      sessionName: 'deck_proj_brain',
      projectName: 'new-proj',
    });
  });

  it('PATCH /sessions/:name/label updates the label and relays session.relabel', async () => {
    const { updateSessionLabel } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/label', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Main Label' }),
    });

    expect(res.status).toBe(200);
    expect(updateSessionLabel).toHaveBeenCalledWith(mockDb, 'srv-1', 'deck_proj_brain', 'Main Label');
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.relabel',
      sessionName: 'deck_proj_brain',
      label: 'Main Label',
    });
  });

  it('allows a covered share participant to relabel a session', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });
    const { updateSessionLabel } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/label', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Shared Label' }),
    });

    expect(res.status).toBe(200);
    expect(updateSessionLabel).toHaveBeenCalledWith(mockDb, 'srv-1', 'deck_proj_brain', 'Shared Label');
  });

  it('denies a shared viewer relabeling a session', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer' },
    });
    const { updateSessionLabel } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/label', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Denied Label' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(updateSessionLabel).not.toHaveBeenCalled();
  });

  it('PATCH /sessions/:name/label allows clearing the label and still relays session.relabel', async () => {
    const { updateSessionLabel } = await import('../src/db/queries.js');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/label', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '' }),
    });

    expect(res.status).toBe(200);
    expect(updateSessionLabel).toHaveBeenCalledWith(mockDb, 'srv-1', 'deck_proj_brain', null);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.relabel',
      sessionName: 'deck_proj_brain',
      label: null,
    });
  });

  it('lets a covered participant switch an already-configured supervision', async () => {
    // A participant drives the session like its owner, so it owns this switch
    // too. What it must NOT be able to do is author the configuration — every
    // field except the mode keeps coming from the stored snapshot.
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 2_000,
    };
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    let storedTransportConfig: Record<string, unknown> = {
      provider: { privateSetting: 'preserved' },
      supervision: {
        mode: 'supervised_audit',
        backend: 'codex-sdk',
        model: 'gpt-5.6-sol',
        timeoutMs: 45_000,
        promptVersion: 'supervision_decision_v1',
        maxParseRetries: 1,
        maxAutoContinueStreak: 2,
        maxAutoContinueTotal: 0,
        maxAuditLoops: 2,
        taskRunPromptVersion: 'task_run_status_v1',
        executionPools: {
          state: 'configured',
          primaryDevelopmentPool: {
            configs: [{
              capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
              agentType: 'codex-sdk',
              providerFamily: 'openai',
              runtimeType: 'transport',
              model: 'gpt-5.6-sol',
            }],
            controls: {},
          },
          economyTaskPool: { configs: [], controls: {} },
        },
      },
    };
    mockGetDbSessionByName.mockImplementation(async () => ({
      name: 'deck_proj_brain',
      role: 'brain',
      agent_type: 'codex-sdk',
      transport_config: storedTransportConfig,
    }));
    mockUpdateSession.mockImplementation(async (
      _db: unknown,
      _serverId: string,
      _sessionName: string,
      patch: { transport_config?: Record<string, unknown> | null },
    ) => {
      storedTransportConfig = patch.transport_config ?? {};
    });
    const app = await buildApp();

    // Exercise a real sequential disable -> re-enable. If the off transition
    // deletes the stored configuration, the second request must fail closed.
    for (const mode of ['off', 'supervised_audit'] as const) {
      mockUpdateSession.mockClear();
      const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supervision: {
            mode,
            backend: 'codex-sdk',
            model: 'gpt-5.4',
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
            maxParseRetries: 1,
            maxAutoContinueStreak: 1,
            maxAutoContinueTotal: 1,
            auditTargetSessionName: 'deck_other_brain',
          },
        }),
      });

      expect(res.status, mode).toBe(200);
      const persisted = mockUpdateSession.mock.calls.at(-1)?.[3] as {
        transport_config?: { provider?: Record<string, unknown>; supervision?: Record<string, unknown> };
      };
      // Unrelated stored config is never collateral damage.
      expect(persisted.transport_config?.provider).toEqual({ privateSetting: 'preserved' });
      // Every field except the mode comes from the STORED snapshot, so the
      // request's model and its forged audit target are both discarded. Off
      // deliberately retains those fields so re-enabling remains possible.
      expect(persisted.transport_config?.supervision).toMatchObject({
        mode,
        backend: 'codex-sdk',
        model: 'gpt-5.6-sol',
        timeoutMs: 45_000,
        maxAuditLoops: 2,
      });
      expect(persisted.transport_config?.supervision).not.toHaveProperty('auditTargetSessionName');
      expect(JSON.stringify(persisted.transport_config?.supervision?.executionPools)).toContain('gpt-5.6-sol');
      const relayed = JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]));
      expect(relayed.sharedActor).toMatchObject({
        actorUserId: 'user-1',
        origin: 'shared-tab',
        effectiveActorRole: 'participant',
        snapshot: { target: coverage.target },
      });
    }

    // The same mode-only operation through a whole-server grant keeps its
    // distinct provenance all the way to the daemon.
    const serverCoverage = { ...coverage, target: { kind: 'server', serverId: 'srv-1' } as const };
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage: serverCoverage },
      shareProvenance: 'server',
    });
    const serverShareResponse = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supervision: { mode: 'off' } }),
    });
    expect(serverShareResponse.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0])).sharedActor).toMatchObject({
      origin: 'shared-server',
      snapshot: { target: serverCoverage.target },
    });
  });

  it('PATCH /sessions/:name/supervision still denies a viewer', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: {
        kind: 'share',
        effectiveActorRole: 'viewer',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'viewer',
        },
      },
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supervision: {
          mode: 'off',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 30_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 1,
          maxAutoContinueTotal: 1,
        },
      }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('PATCH /sessions/:name/supervision lets a whole-server participant author owner-equivalent config', async () => {
    const coverage = {
      target: { kind: 'server', serverId: 'srv-1' } as const,
      effectiveRole: 'participant' as const,
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['server-share-1'],
      primaryShareId: 'server-share-1',
      authorizedAt: 2_000,
    };
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
      shareProvenance: 'server',
    });
    mockGetDbSessionByName.mockResolvedValue({
      name: 'deck_proj_brain',
      role: 'brain',
      agent_type: 'codex-sdk',
      transport_config: null,
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supervision: { mode: 'off' } }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateSession).toHaveBeenCalled();
    expect(JSON.parse(String(sendToDaemonMock.mock.calls.at(-1)?.[0]))).toMatchObject({
      sharedActor: {
        origin: 'shared-server',
        snapshot: { target: coverage.target },
      },
    });
  });

  it('PATCH /sessions/:name/supervision accepts automatic audit routed from the live pool', async () => {
    mockGetDbSessionByName.mockResolvedValue({
      name: 'deck_proj_brain',
      role: 'brain',
      agent_type: 'codex-sdk',
      transport_config: null,
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.6-sol',
          timeoutMs: 30_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: {
              configs: [{
                capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
                agentType: 'codex-sdk',
                providerFamily: 'openai',
                runtimeType: 'transport',
                model: 'gpt-5.6-sol',
              }],
              controls: {},
            },
            economyTaskPool: { configs: [], controls: {} },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const persisted = mockUpdateSession.mock.calls.at(-1)?.[3] as {
      transport_config?: { supervision?: Record<string, unknown> };
    };
    expect(persisted.transport_config?.supervision).toMatchObject({ mode: 'supervised_audit' });
    expect(persisted.transport_config?.supervision).not.toHaveProperty('auditTargetSessionName');
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
  });

  it('PATCH /sessions/:name/supervision rejects when the merged stored snapshot has no usable audit pool', async () => {
    mockGetDbSessionByName.mockResolvedValue({
      name: 'deck_proj_brain',
      role: 'brain',
      agent_type: 'codex-sdk',
      transport_config: {
        supervision: {
          mode: 'off',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          executionPools: { state: 'legacy_unconfigured' },
        },
      },
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.6-sol',
          timeoutMs: 30_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: {
              configs: [{
                capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
                agentType: 'codex-sdk',
                providerFamily: 'openai',
                runtimeType: 'transport',
                model: 'gpt-5.6-sol',
              }],
              controls: {},
            },
            economyTaskPool: { configs: [], controls: {} },
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'supervision_execution_pool_required',
      reason: 'supervision_pools_legacy_unconfigured',
    });
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('PATCH /sessions/:name/supervision refuses enablement for a non-Brain session', async () => {
    mockGetDbSessionByName.mockResolvedValue({
      name: 'deck_proj_worker',
      role: 'w1',
      agent_type: 'codex-sdk',
      transport_config: null,
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_worker/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.6-sol',
          timeoutMs: 30_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
        },
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'brain_session_required' });
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('PATCH /sessions/:name/supervision denies viewers and uncovered share actors before mutation', async () => {
    const app = await buildApp();
    for (const actor of [
      {
        kind: 'share',
        effectiveActorRole: 'viewer',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'viewer',
          historyCutoffAt: 1_000,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-viewer'],
          primaryShareId: 'share-viewer',
          authorizedAt: 2_000,
        },
      },
      { kind: 'none' },
    ]) {
      mockResolveHttpShareAccessForCoveredSession.mockResolvedValueOnce({ actor });
      const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supervision: { mode: 'off' } }),
      });
      expect(res.status).toBe(403);
    }
    expect(mockGetDbSessionByName).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('PATCH /sessions/:name/supervision lets a covered participant author automatic supervision from scratch', async () => {
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 2_000,
    };
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    mockGetDbSessionByName.mockResolvedValue({
      name: 'deck_proj_brain',
      role: 'brain',
      agent_type: 'codex-sdk',
      transport_config: {},
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.6-sol',
          timeoutMs: 30_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: {
              configs: [{
                capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
                agentType: 'codex-sdk',
                providerFamily: 'openai',
                runtimeType: 'transport',
                model: 'gpt-5.6-sol',
              }],
              controls: {},
            },
            economyTaskPool: { configs: [], controls: {} },
          },
        },
      }),
    });

    // The session had no stored supervision. A participant may now author a
    // fresh pool-routed configuration instead of being refused outright.
    expect(res.status).toBe(200);
    const persisted = mockUpdateSession.mock.calls.at(-1)?.[3] as {
      transport_config?: { supervision?: Record<string, unknown> };
    };
    expect(persisted.transport_config?.supervision).toMatchObject({ mode: 'supervised_audit' });
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
  });

  it('PATCH /sessions/:name/supervision strips a forged audit target when a participant authors from scratch', async () => {
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 2_000,
    };
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    mockGetDbSessionByName.mockResolvedValue({
      name: 'deck_proj_brain',
      role: 'brain',
      agent_type: 'codex-sdk',
      transport_config: {},
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.6-sol',
          timeoutMs: 30_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
          // A participant authoring from scratch must never be able to name
          // itself (or any other session) as the trusted manual auditor —
          // only the pool-routed path above is available to it.
          auditTargetSessionName: 'deck_other_brain',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: {
              configs: [{
                capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6-sol',
                agentType: 'codex-sdk',
                providerFamily: 'openai',
                runtimeType: 'transport',
                model: 'gpt-5.6-sol',
              }],
              controls: {},
            },
            economyTaskPool: { configs: [], controls: {} },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const persisted = mockUpdateSession.mock.calls.at(-1)?.[3] as {
      transport_config?: { supervision?: Record<string, unknown> };
    };
    expect(persisted.transport_config?.supervision).not.toHaveProperty('auditTargetSessionName');
  });

  it('reads and writes the machine owner supervision defaults for a covered participant', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
        },
      },
    });
    mockGetUserPref.mockResolvedValue(JSON.stringify({
      backend: 'claude-code-sdk',
      model: 'MiniMax-M2.7',
      preset: 'MiniMax Owner',
      timeoutMs: 50_000,
      promptVersion: 'supervision_decision_v1',
    }));
    const app = await buildApp();

    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision/defaults');
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      defaults: expect.objectContaining({
        backend: 'claude-code-sdk',
        model: 'MiniMax-M2.7',
        preset: 'MiniMax Owner',
      }),
    });
    expect(mockGetUserPref).toHaveBeenCalledWith(mockDb, 'owner-user', 'supervision.user_default');

    const write = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision/defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaults: {
          backend: 'claude-code-sdk',
          model: 'MiniMax-M2.7',
          preset: 'MiniMax Owner',
          timeoutMs: 55_000,
          promptVersion: 'supervision_decision_v1',
          executionPools: {
            state: 'configured',
            primaryDevelopmentPool: {
              configs: [{
                capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-6-luna',
                agentType: 'codex-sdk', providerFamily: 'openai', runtimeType: 'transport', model: 'gpt-6-luna', role: 'executor',
              }],
            },
            economyTaskPool: { configs: [] },
          },
        },
      }),
    });
    expect(write.status).toBe(200);
    expect(mockSetUserPref).toHaveBeenCalledWith(
      mockDb,
      'owner-user',
      'supervision.user_default',
      expect.any(String),
    );
    const stored = JSON.parse(String(mockSetUserPref.mock.calls[0]?.[3]));
    expect(stored).toEqual(expect.objectContaining({
      backend: 'claude-code-sdk',
      model: 'MiniMax-M2.7',
      preset: 'MiniMax Owner',
    }));
    expect(stored.executionPools.primaryDevelopmentPool.configs[0].role).toBe('executor');
    // The daemon's own poll would notice this within five seconds regardless,
    // but manual task dispatch right after a fresh save must not race that
    // window -- the save pushes an immediate refresh over the existing WS link.
    expect(sendToDaemonMock).toHaveBeenCalledWith(JSON.stringify({
      type: DAEMON_COMMAND_TYPES.SUPERVISOR_DEFAULTS_CHANGED,
    }));
  });

  it('denies single-session participants PROJECT/USER identity while allowing whole-server participants PROJECT identity and denying USER identity', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
        },
      },
      shareProvenance: 'session',
    });
    const app = await buildApp();

    // Concrete single-session participant cannot read/write/delete PROJECT or USER identity
    expect((await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=project&scopeKey=repo-stable-id')).status).toBe(403);
    expect((await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', scopeKey: 'repo-stable-id', content: 'Participant overwrite' }),
    })).status).toBe(403);
    expect((await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=user&scopeKey=')).status).toBe(403);
    expect(sendSessionIdentityLocalRequestMock).not.toHaveBeenCalled();

    // Whole-server participant can read/write/delete PROJECT identity under owner server, but NEVER USER identity
    resolveSessionIdentityProjectKeyMock.mockReturnValue('repo-stable-id');
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'server', serverId: 'srv-1' },
          effectiveRole: 'participant',
        },
      },
      shareProvenance: 'server',
    });
    expect((await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=user&scopeKey=')).status).toBe(403);

    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', content: 'Owner identity', contentHash: 'owner-hash', revision: 4, updatedAt: 10,
    });
    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=project&scopeKey=repo-stable-id');
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      profile: expect.objectContaining({ scope: 'project', scopeKey: 'repo-stable-id', content: 'Owner identity' }),
    });
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'get', scope: 'project', scopeKey: 'repo-stable-id' },
      expect.any(Number),
    );

    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({ status: 'ok', contentHash: 'overwrite-hash', revision: 1, updatedAt: 20 });
    mockDbQueryOne.mockResolvedValueOnce({
      scope: 'project', scope_key: 'repo-stable-id', content_hash: 'overwrite-hash', content_length: 20,
      revision: 5, updated_at: 20, source: 'web', source_file: null,
    });
    const write = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', scopeKey: 'repo-stable-id', content: 'Participant overwrite' }),
    });
    expect(write.status).toBe(200);
    await expect(write.json()).resolves.toEqual({
      profile: expect.objectContaining({ content: 'Participant overwrite', revision: 5 }),
    });
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      expect.objectContaining({ op: 'set', scope: 'project', scopeKey: 'repo-stable-id', content: 'Participant overwrite' }),
      expect.any(Number),
    );
    expect(mockDbQueryOne).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO session_identity_metadata'),
      expect.arrayContaining(['owner-user', 'project', 'repo-stable-id', 'overwrite-hash']));

    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({ status: 'ok' });
    const clear = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=project&scopeKey=repo-stable-id', {
      method: 'DELETE',
    });
    expect(clear.status).toBe(200);
    await expect(clear.json()).resolves.toEqual({ deleted: true });
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'delete', scope: 'project', scopeKey: 'repo-stable-id' },
      expect.any(Number),
    );
    expect(mockDbExecute).toHaveBeenLastCalledWith(expect.stringContaining('DELETE FROM session_identity_metadata'), [
      'owner-user', 'project', 'repo-stable-id',
    ]);
    resolveSessionIdentityProjectKeyMock.mockImplementation(() => null);
  });

  it('reads a whole-server participant project identity under canonical key and fails closed when canonical key is null', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'server',
    });
    resolveSessionIdentityProjectKeyMock.mockImplementation((name) => (
      name === 'deck_proj_brain' ? 'github-org/repo' : null
    ));
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', content: 'Owner project identity', contentHash: 'h', revision: 1, updatedAt: 10,
    });
    const app = await buildApp();

    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=project&scopeKey=proj');
    expect(read.status).toBe(200);
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'get', scope: 'project', scopeKey: 'github-org/repo' },
      expect.any(Number),
    );

    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({ status: 'ok', contentHash: 'edited-hash', revision: 2, updatedAt: 30 });
    mockDbQueryOne.mockResolvedValueOnce({
      scope: 'project', scope_key: 'github-org/repo', content_hash: 'edited-hash', content_length: 21,
      revision: 2, updated_at: 30, source: 'web', source_file: null,
    });
    const write = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'project', scopeKey: 'proj', content: 'Edited by participant' }),
    });
    expect(write.status).toBe(200);
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      expect.objectContaining({ op: 'set', scope: 'project', scopeKey: 'github-org/repo', content: 'Edited by participant' }),
      expect.any(Number),
    );

    // When canonical project key returns null for a non-owner, fail closed instead of accepting caller scopeKey
    resolveSessionIdentityProjectKeyMock.mockImplementation(() => null);
    const failClosed = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=project&scopeKey=arbitrary-key');
    expect(failClosed.status).toBe(400);
  });

  it('pins the session identity key to the covered session', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({ status: 'ok' });
    const app = await buildApp();

    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=session&scopeKey=srv-1:deck_other_brain');
    expect(read.status).toBe(200);
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'get', scope: 'session', scopeKey: 'srv-1:deck_proj_brain' },
      expect.any(Number),
    );
  });

  it('relays pair identity get with sessionName when scopeKey is omitted', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', scopeKey: 'tsk_pair_123', content: 'Pair identity prompt', contentHash: 'phash', revision: 1, updatedAt: 50,
    });
    const app = await buildApp();

    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=pair');
    expect(read.status).toBe(200);
    const body = await read.json() as { profile?: { scope: string; scopeKey: string; content: string } };
    expect(body.profile).toEqual(expect.objectContaining({
      scope: 'pair',
      scopeKey: 'tsk_pair_123',
      content: 'Pair identity prompt',
    }));
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'get', scope: 'pair', scopeKey: '', sessionName: 'deck_proj_brain' },
      expect.any(Number),
    );
  });

  it('relays pair identity get and returns scopeKey even when profile has no stored content', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', scopeKey: 'tsk_pair_456',
    });
    const app = await buildApp();

    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=pair');
    expect(read.status).toBe(200);
    const body = await read.json() as { profile?: unknown; scopeKey?: string };
    expect(body.profile).toBeNull();
    expect(body.scopeKey).toBe('tsk_pair_456');
  });

  it('discards client-supplied pair scopeKey on concrete session share GET/PUT/DELETE while keeping owner explicit pair scopeKey', async () => {
    const app = await buildApp();
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'session',
    });

    // 1) Linked pair GET with spoofed scopeKey -> ignores client scopeKey, sends '', gets authoritative linked pair
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', scopeKey: 'tsk_pair_linked', content: 'Linked prompt', contentHash: 'lh', revision: 3, updatedAt: 90,
    });
    const linkedGet = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=pair&scopeKey=tsk_victim_999');
    expect(linkedGet.status).toBe(200);
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'get', scope: 'pair', scopeKey: '', sessionName: 'deck_proj_brain' },
      expect.any(Number),
    );
    await expect(linkedGet.json()).resolves.toMatchObject({
      profile: { scope: 'pair', scopeKey: 'tsk_pair_linked', content: 'Linked prompt' },
    });

    // 2) Unlinked / offline pair GET -> does NOT fall back to DB metadata lookup using spoofed scopeKey
    mockDbQueryOne.mockClear();
    sendSessionIdentityLocalRequestMock.mockRejectedValueOnce(new Error('daemon_offline'));
    const offlineGet = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=pair&scopeKey=tsk_victim_999');
    expect(offlineGet.status).toBe(409);
    await expect(offlineGet.json()).resolves.toEqual({ error: 'daemon_offline' });
    expect(mockDbQueryOne).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM session_identity_metadata'),
      expect.anything(),
    );

    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({ status: 'ok' });
    const unlinkedOnlineGet = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=pair&scopeKey=tsk_victim_999');
    expect(unlinkedOnlineGet.status).toBe(200);
    await expect(unlinkedOnlineGet.json()).resolves.toEqual({ profile: null });

    // 3) PUT with spoofed scopeKey -> relays '', writes metadata only for authoritative returned scopeKey
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', scopeKey: 'tsk_pair_linked', contentHash: 'new-lh', revision: 4, updatedAt: 100,
    });
    mockDbQueryOne.mockResolvedValueOnce({
      scope: 'pair', scope_key: 'tsk_pair_linked', content_hash: 'new-lh', content_length: 12,
      revision: 4, updated_at: 100, source: 'web', source_file: null,
    });
    const putRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'pair', scopeKey: 'tsk_victim_999', content: 'Updated pair' }),
    });
    expect(putRes.status).toBe(200);
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      expect.objectContaining({ op: 'set', scope: 'pair', scopeKey: '', sessionName: 'deck_proj_brain', content: 'Updated pair' }),
      expect.any(Number),
    );
    expect(mockDbQueryOne).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO session_identity_metadata'),
      expect.arrayContaining(['owner-user', 'pair', 'tsk_pair_linked']),
    );

    // Unlinked PUT -> daemon rejects invalid local pair request -> 502 and no metadata written
    mockDbQueryOne.mockClear();
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({ status: 'error', error: 'identity_local_request_invalid' });
    const unlinkedPut = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'pair', scopeKey: 'tsk_victim_999', content: 'Blocked tamper' }),
    });
    expect(unlinkedPut.status).toBe(502);
    expect(mockDbQueryOne).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO session_identity_metadata'),
      expect.anything(),
    );

    // 4) DELETE with spoofed scopeKey -> relays '', deletes only daemon-returned scopeKey, never spoofed key
    mockDbExecute.mockClear();
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({ status: 'ok', scopeKey: 'tsk_pair_linked' });
    const delRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=pair&scopeKey=tsk_victim_999', {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'delete', scope: 'pair', scopeKey: '', sessionName: 'deck_proj_brain' },
      expect.any(Number),
    );
    expect(mockDbExecute).toHaveBeenLastCalledWith(
      expect.stringContaining('DELETE FROM session_identity_metadata'),
      ['owner-user', 'pair', 'tsk_pair_linked'],
    );

    // 5) Direct owner explicit-keyed PAIR continues to use caller scopeKey
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'owner',
      actor: { kind: 'server-member', effectiveActorRole: 'server-manager' },
    });
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', scopeKey: 'tsk_owner_123', content: 'Owner pair', contentHash: 'oh', revision: 1, updatedAt: 10,
    });
    const ownerGet = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=pair&scopeKey=tsk_owner_123');
    expect(ownerGet.status).toBe(200);
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'get', scope: 'pair', scopeKey: 'tsk_owner_123', sessionName: 'deck_proj_brain' },
      expect.any(Number),
    );
  });

  it('serves the machine owner\'s identity to a whole-server participant before any session exists', async () => {
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'server',
    });
    sendSessionIdentityLocalRequestMock.mockResolvedValueOnce({
      status: 'ok', content: 'Owner project identity', contentHash: 'h', revision: 1, updatedAt: 10,
    });
    const app = await buildApp();

    const read = await app.request('/api/server/srv-1/identity?scope=project&scopeKey=proj');
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      profile: expect.objectContaining({ scope: 'project', content: 'Owner project identity' }),
    });
    expect(sendSessionIdentityLocalRequestMock).toHaveBeenLastCalledWith(
      expect.stringContaining('identity-'),
      { op: 'get', scope: 'project', scopeKey: 'proj' },
      expect.any(Number),
    );
  });

  it('refuses the server-level identity route to session-scoped participants and viewers', async () => {
    const app = await buildApp();
    mockResolveHttpShareAccess.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'session',
    });
    expect((await app.request('/api/server/srv-1/identity?scope=user&scopeKey=')).status).toBe(403);
    mockResolveHttpShareAccess.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer' },
      shareProvenance: 'server',
    });
    expect((await app.request('/api/server/srv-1/identity?scope=user&scopeKey=')).status).toBe(403);
  });

  it('projects every valid owner-group execution candidate to a participant even when both pools are empty', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
        },
      },
    });
    mockGetSubSessionsByServer.mockResolvedValue([
      {
        id: 'cx_one', parent_session: 'deck_proj_brain', type: 'codex-sdk', runtime_type: 'transport',
        provider_id: 'openai', active_model: 'gpt-5.6', requested_model: null, cc_preset_id: null, label: 'Cx one',
      },
      {
        id: 'cx_two', parent_session: 'deck_proj_brain', type: 'codex-sdk', runtime_type: 'transport',
        provider_id: 'openai', active_model: 'gpt-5.6', requested_model: null, cc_preset_id: null, label: 'Cx two',
      },
      {
        id: 'cc_preset', parent_session: 'deck_proj_brain', type: 'claude-code-sdk', runtime_type: 'transport',
        provider_id: 'anthropic', active_model: 'MiniMax-M3', requested_model: null, cc_preset_id: 'preset-a', label: 'CC preset',
      },
      {
        id: 'shell', parent_session: 'deck_proj_brain', type: 'shell', runtime_type: 'process',
        provider_id: null, active_model: 'shell', requested_model: null, cc_preset_id: null, label: 'Shell',
      },
      {
        id: 'bad_preset', parent_session: 'deck_proj_brain', type: 'claude-code-sdk', runtime_type: 'transport',
        provider_id: 'anthropic', active_model: 'MiniMax-M3', requested_model: null, cc_preset_id: ' preset-a', label: 'Bad',
      },
      {
        id: 'other', parent_session: 'deck_other_brain', type: 'codex-sdk', runtime_type: 'transport',
        provider_id: 'openai', active_model: 'gpt-5.6', requested_model: null, cc_preset_id: null, label: 'Other',
      },
    ]);
    const app = await buildApp();

    const response = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision/execution-pool-catalog');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [
        expect.objectContaining({
          sessionName: 'deck_sub_cx_one',
          parentSession: 'deck_proj_brain',
          capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6',
          ownerCatalog: true,
        }),
        expect.objectContaining({
          sessionName: 'deck_sub_cx_two',
          capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6',
          ownerCatalog: true,
        }),
        expect.objectContaining({
          sessionName: 'deck_sub_cc_preset',
          ccPresetId: 'preset-a',
          capabilityId: 'supervision-exec-v1-cc-preset:transport:claude-code-sdk:anthropic:preset-a:minimax-m3',
          ownerCatalog: true,
        }),
      ],
    });
    expect(mockGetSubSessionsByServer).toHaveBeenCalledWith(mockDb, 'srv-1', { includeExecutionClones: false });
    expect(mockGetUserPref).not.toHaveBeenCalled();
  });

  it('denies viewers access to the machine owner supervision defaults', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'viewer' },
    });
    const app = await buildApp();
    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision/defaults');
    const write = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision/defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaults: { backend: 'qwen', model: 'qwen3-coder-plus' } }),
    });
    const catalog = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision/execution-pool-catalog');
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(catalog.status).toBe(403);
    expect(mockGetUserPref).not.toHaveBeenCalled();
    expect(mockSetUserPref).not.toHaveBeenCalled();
    expect(mockGetSubSessionsByServer).not.toHaveBeenCalled();
  });

  it('keeps the machine owner identity read-only for shared viewers', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      actor: { kind: 'share', effectiveActorRole: 'viewer' },
    });
    const app = await buildApp();
    const read = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity?scope=user&scopeKey=');
    const write = await app.request('/api/server/srv-1/sessions/deck_proj_brain/identity', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'user', scopeKey: '', content: 'Forbidden' }),
    });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(mockDbQueryOne).not.toHaveBeenCalled();
  });

  it('fails the owner execution catalog closed for inactive shares and malformed sub-session targets', async () => {
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({ actor: { kind: 'none' } });
    const app = await buildApp();

    const inactive = await app.request('/api/server/srv-1/sessions/deck_proj_brain/supervision/execution-pool-catalog');
    const malformed = await app.request('/api/server/srv-1/sessions/deck_sub_/supervision/execution-pool-catalog');
    expect(inactive.status).toBe(403);
    expect(malformed.status).toBe(400);
    expect(mockGetSubSessionsByServer).not.toHaveBeenCalled();
  });

  it('POST /session/send allows share participants and stamps a server-authored sharedActor', async () => {
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 2_000,
    };
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    mockDbQueryOne.mockResolvedValue({ display_name: 'Shared User', username: 'shared' });
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        text: 'hello',
        commandId: 'cmd-1',
        sharedActor: { actorUserId: 'spoofed' },
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toMatchObject({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'hello',
      commandId: 'cmd-1',
      sharedActor: {
        actorUserId: 'user-1',
        actorDisplayName: 'Shared User',
        snapshot: coverage,
        primaryShareId: 'share-1',
        effectiveActorRole: 'participant',
        actionId: 'cmd-1',
        origin: 'shared-tab',
        authorizedAt: 2_000,
        queuedAt: expect.any(Number),
      },
    });
    expect(mockDbExecute).toHaveBeenCalled();
  });

  it('POST /session/send denies tab-share P2P routing extras outside live coverage before daemon relay', async () => {
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 2_000,
    };
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    const app = await buildApp();

    const deniedBodies = [
      { commandId: 'cmd-direct', directTargetSession: 'deck_other_brain' },
      { commandId: 'cmd-at', p2pAtTargets: [{ session: 'deck_other_brain', mode: 'review' }] },
      { commandId: 'cmd-config', p2pSessionConfig: { deck_other_brain: { enabled: true, mode: 'review' } } },
      { commandId: 'cmd-implicit', p2pMode: 'review' },
      { commandId: 'cmd-all', directTargetSession: '__all__' },
    ];

    for (const extra of deniedBodies) {
      sendToDaemonMock.mockClear();
      mockDbExecute.mockClear();
      const res = await app.request('/api/server/srv-1/session/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionName: 'deck_proj_brain',
          text: 'hello',
          ...extra,
        }),
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-direct-surface-denied' });
      expect(sendToDaemonMock).not.toHaveBeenCalled();
      expect(mockDbExecute).toHaveBeenCalled();
    }
  });

  it('POST /session/send lets a shared main tab P2P-route to its covered child sub-session', async () => {
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 2_000,
    };
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    mockGetSubSessionsByServer.mockResolvedValue([
      { id: 'child_1', parent_session: 'deck_proj_brain' },
    ]);
    mockDbQueryOne.mockResolvedValue({ display_name: 'Shared User', username: 'shared' });
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        text: 'hello child',
        commandId: 'cmd-child',
        p2pAtTargets: [{ session: 'deck_sub_child_1', mode: 'review' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual(expect.objectContaining({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      commandId: 'cmd-child',
      p2pAtTargets: [{ session: 'deck_sub_child_1', mode: 'review' }],
      sharedActor: expect.objectContaining({
        actorUserId: 'user-1',
        actorDisplayName: 'Shared User',
      }),
    }));
  });

  it('POST /session/send preserves participant server-share broad P2P routing', async () => {
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['server-share-1'],
      primaryShareId: 'server-share-1',
      authorizedAt: 2_000,
    };
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    mockDbQuery.mockResolvedValue([
      {
        target_kind: 'server',
        id: 'server-share-1',
        server_id: 'srv-1',
        session_name: null,
        sub_session_id: null,
        target_user_id: 'user-1',
        role: 'participant',
        created_by: 'owner-1',
        created_at: 1_000,
        updated_at: 1_000,
        expires_at: null,
        revoked_at: null,
      },
    ]);
    mockDbQueryOne.mockResolvedValue({ display_name: 'Shared User', username: 'shared' });
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        text: 'server-wide dispatch',
        commandId: 'cmd-server-wide',
        p2pMode: 'review',
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual(expect.objectContaining({
      type: 'session.send',
      commandId: 'cmd-server-wide',
      p2pMode: 'review',
    }));
  });

  it('POST /session/send denies share viewers before daemon relay', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: {
        kind: 'share',
        effectiveActorRole: 'viewer',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'viewer',
          historyCutoffAt: 1_000,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-1'],
          primaryShareId: 'share-1',
          authorizedAt: 2_000,
        },
      },
    });
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_proj_brain', text: 'hello' }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();
    expect(mockDbExecute).toHaveBeenCalled();
  });

  it('POST /session/cancel allows share participants only for trusted transport sessions and forwards observedDispatchId', async () => {
    const coverage = {
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
      effectiveRole: 'participant',
      historyCutoffAt: 1_000,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['share-1'],
      primaryShareId: 'share-1',
      authorizedAt: 2_000,
    };
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
    });
    mockDbQueryOne.mockImplementation(async (sql: string) => (
      sql.includes('runtime_type')
        ? { runtime_type: 'transport' }
        : { display_name: null, username: 'shared' }
    ));
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        commandId: 'cancel-1',
        stopAndSendPendingMessageIds: ['queued-1'],
        observedDispatchId: 'dispatch-1',
        text: '/stop',
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL,
      sessionName: 'deck_proj_brain',
      commandId: 'cancel-1',
        stopAndSendPendingMessageIds: ['queued-1'],
      observedDispatchId: 'dispatch-1',
      sharedActor: expect.objectContaining({
        actorUserId: 'user-1',
        actorDisplayName: 'shared',
        actionId: 'cancel-1',
        snapshot: coverage,
      }),
    });
    expect(mockDbExecute).toHaveBeenCalled();
  });

  it('POST /session/cancel rejects process-backed shared tabs with share-cancel-unsupported', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
          historyCutoffAt: 1_000,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-1'],
          primaryShareId: 'share-1',
          authorizedAt: 2_000,
        },
      },
    });
    mockDbQueryOne.mockResolvedValue({ runtime_type: 'process' });
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        commandId: 'cancel-1',
        observedDispatchId: 'dispatch-1',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-cancel-unsupported' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('POST /session/cancel relays a shared transport cancel when the server knows no running dispatch (turn started outside the bridge)', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
          historyCutoffAt: 1_000,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-1'],
          primaryShareId: 'share-1',
          authorizedAt: 2_000,
        },
      },
    });
    mockDbQueryOne.mockResolvedValue({ runtime_type: 'transport' });
    getActiveDispatchIdForSessionMock.mockReturnValue(null);
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_proj_brain', commandId: 'cancel-queued-turn' }),
    });

    expect(res.status).toBe(200);
    expect(sendToDaemonMock).toHaveBeenCalled();
  });

  it('POST /session/cancel rejects shared transport cancel without observedDispatchId while a dispatch is running, naming it', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
          historyCutoffAt: 1_000,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-1'],
          primaryShareId: 'share-1',
          authorizedAt: 2_000,
        },
      },
    });
    mockDbQueryOne.mockResolvedValue({ runtime_type: 'transport' });
    getActiveDispatchIdForSessionMock.mockReturnValue('dispatch-current');
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        commandId: 'cancel-1',
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'not_canceled', reason: 'share-dispatch-changed', activeDispatchId: 'dispatch-current' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('POST /session/cancel rejects stale shared transport observedDispatchId before daemon relay', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: {
        kind: 'share',
        effectiveActorRole: 'participant',
        coverage: {
          target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_proj_brain' },
          effectiveRole: 'participant',
          historyCutoffAt: 1_000,
          nextCoverageRecheckAt: null,
          coveringShareIds: ['share-1'],
          primaryShareId: 'share-1',
          authorizedAt: 2_000,
        },
      },
    });
    mockDbQueryOne.mockResolvedValue({ runtime_type: 'transport' });
    getActiveDispatchIdForSessionMock.mockReturnValue('dispatch-current');
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionName: 'deck_proj_brain',
        commandId: 'cancel-stale',
        observedDispatchId: 'dispatch-old',
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'not_canceled', reason: 'share-dispatch-changed', activeDispatchId: 'dispatch-current' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();
    expect(mockDbExecute).toHaveBeenCalled();
  });

  it('POST /session/stop denies share-only users with a stable direct-surface reason', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({
      ok: false,
      reason: 'share-direct-surface-denied',
    });
    const app = await buildApp();

    const res = await app.request('/api/server/srv-1/session/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-direct-surface-denied' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('rejects shell/script create, patch, and send for BOTH tab-share and whole-server-share participants while keeping LLM & owner access', async () => {
    const app = await buildApp();
    const serverCoverage = {
      target: { kind: 'server', serverId: 'srv-1' } as const,
      effectiveRole: 'participant' as const,
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['server-share-1'],
      primaryShareId: 'server-share-1',
      authorizedAt: Date.now(),
      serverParticipantAuthority: true,
    };

    // 1. Whole-server participant POST /session/start with shell or script -> 200 with stamped sharedActor; viewer -> 403 share-role-denied
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage: serverCoverage },
      shareProvenance: 'server',
    });
    for (const agentType of ['shell', 'script']) {
      sendToDaemonMock.mockClear();
      const startRes = await app.request('/api/server/srv-1/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: `shproj_${agentType}`, dir: `/tmp/shproj_${agentType}`, agentType, sharedActor: { effectiveActorRole: 'owner' } }),
      });
      expect(startRes.status).toBe(200);
      expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toMatchObject({
        type: 'session.start',
        agentType,
        sharedActor: { effectiveActorRole: 'participant', origin: 'shared-server' },
      });
    }
    sendToDaemonMock.mockClear();

    // Whole-server viewer remains denied even for shell/script start
    mockResolveHttpShareAccess.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer', coverage: { ...serverCoverage, effectiveRole: 'viewer' } },
      shareProvenance: 'server',
    });
    const viewerStartRes = await app.request('/api/server/srv-1/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'vwsh', dir: '/tmp/vwsh', agentType: 'shell' }),
    });
    expect(viewerStartRes.status).toBe(403);
    expect(await viewerStartRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();

    // Whole-server participant POST /session/start with LLM succeeds and stamps server-owned sharedActor
    const llmStartRes = await app.request('/api/server/srv-1/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'llmproj',
        dir: '/tmp/llmproj',
        agentType: 'claude-code',
        sharedActor: { effectiveActorRole: 'owner' },
      }),
    });
    expect(llmStartRes.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toMatchObject({
      type: 'session.start',
      project: 'llmproj',
      agentType: 'claude-code',
      sharedActor: { effectiveActorRole: 'participant', origin: 'shared-server' },
    });
    sendToDaemonMock.mockClear();

    // Live bridge type 'shell' still permits PATCH /sessions/:name for authorized participant
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage: serverCoverage },
      shareProvenance: 'server',
    });
    mockGetDbSessionByName.mockResolvedValueOnce({ name: 'deck_live_sh', role: 'brain', agent_type: 'claude-code' });
    resolveSessionAgentTypeMock.mockResolvedValueOnce('shell');
    const liveMismatchPatch = await app.request('/api/server/srv-1/sessions/deck_live_sh', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'renamed-shell' }),
    });
    expect(liveMismatchPatch.status).toBe(200);

    // Whole-server participant POST /session/send to LLM brain with P2P target pointing to shell sub-session -> 200 with stamped sharedActor
    mockDbQueryOne.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM sessions')) return { project_name: 'proj' };
      return { display_name: 'Shared User', username: 'shared' };
    });
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM server_shares')) {
        return [{
          target_kind: 'server',
          id: 'server-share-1',
          server_id: 'srv-1',
          session_name: null,
          sub_session_id: null,
          target_user_id: 'user-1',
          role: 'participant',
          created_by: 'owner-user',
          created_at: 1000,
          updated_at: 1000,
          expires_at: null,
          revoked_at: null,
        }];
      }
      return [];
    });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage: serverCoverage },
      shareProvenance: 'server',
    });
    mockGetDbSessionByName.mockResolvedValue({ name: 'deck_proj_brain', role: 'brain', agent_type: 'claude-code' });
    mockGetSubSessionById.mockImplementation(async (_db: unknown, subId: string) => (
      subId === 'subsh1' ? { id: 'subsh1', server_id: 'srv-1', type: 'shell', parent_session: 'deck_proj_brain', closed_at: null } : null
    ));
    mockGetSubSessionsByServer.mockResolvedValue([
      { id: 'subsh1', server_id: 'srv-1', type: 'shell', parent_session: 'deck_proj_brain', closed_at: null },
    ]);
    for (const p2pPayload of [
      { sessionName: 'deck_proj_brain', text: '@@discuss(deck_sub_subsh1, audit)' },
      { sessionName: 'deck_proj_brain', text: 'check', p2pAtTargets: [{ session: 'deck_sub_subsh1', mode: 'audit' }] },
      { sessionName: 'deck_proj_brain', text: 'check', p2pSessionConfig: { deck_sub_subsh1: { enabled: true, mode: 'audit' } } },
    ]) {
      sendToDaemonMock.mockClear();
      const p2pRes = await app.request('/api/server/srv-1/session/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p2pPayload),
      });
      expect(p2pRes.status).toBe(200);
      expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toMatchObject({
        type: 'session.send',
        sharedActor: { effectiveActorRole: 'participant', origin: 'shared-server' },
      });
    }
    sendToDaemonMock.mockClear();

    // 2. Whole-server participant PATCH /sessions/:name to shell/script OR on existing shell session -> 200
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage: serverCoverage },
      shareProvenance: 'server',
    });
    for (const agentType of ['shell', 'script']) {
      const patchRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType }),
      });
      expect(patchRes.status).toBe(200);
    }
    mockGetDbSessionByName.mockResolvedValueOnce({
      name: 'deck_sh_brain',
      role: 'brain',
      agent_type: 'shell',
    });
    const patchExistingShell = await app.request('/api/server/srv-1/sessions/deck_sh_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'renamed' }),
    });
    expect(patchExistingShell.status).toBe(200);

    // 3. Tab-share & whole-server participant POST /session/send targeting covered shell/script sub-session -> 200 with stamped sharedActor; viewer -> 403 share-role-denied
    mockGetSubSessionById.mockResolvedValue({ id: 'subsh1', server_id: 'srv-1', type: 'shell' });
    for (const [provenance, expectedOrigin, coverage] of [
      ['session', 'shared-tab', {
        target: { kind: 'subsession', serverId: 'srv-1', subSessionId: 'subsh1' } as const,
        effectiveRole: 'participant' as const,
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['tab-share-1'],
        primaryShareId: 'tab-share-1',
        authorizedAt: Date.now(),
      }],
      ['server', 'shared-server', serverCoverage],
    ] as const) {
      sendToDaemonMock.mockClear();
      mockResolveHttpShareAccess.mockResolvedValue({
        membership: 'none',
        actor: { kind: 'share', effectiveActorRole: 'participant', coverage },
        shareProvenance: provenance,
      });
      const sendRes = await app.request('/api/server/srv-1/session/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName: 'deck_sub_subsh1', text: 'id' }),
      });
      expect(sendRes.status).toBe(200);
      expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toMatchObject({
        type: 'session.send',
        sessionName: 'deck_sub_subsh1',
        sharedActor: { effectiveActorRole: 'participant', origin: expectedOrigin },
      });
    }
    sendToDaemonMock.mockClear();
    mockResolveHttpShareAccess.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer', coverage: { ...serverCoverage, effectiveRole: 'viewer' } },
      shareProvenance: 'server',
    });
    const viewerSendRes = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_sub_subsh1', text: 'id' }),
    });
    expect(viewerSendRes.status).toBe(403);
    expect(await viewerSendRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();

    // 4. Owner still creates and sends to shell sessions normally
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'owner',
      actor: { kind: 'server-member', effectiveActorRole: 'server-manager' },
    });
    const ownerStart = await app.request('/api/server/srv-1/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'ownersh', dir: '/tmp/ownersh', agentType: 'shell' }),
    });
    expect(ownerStart.status).toBe(200);
    const ownerSend = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_sub_subsh1', text: 'id' }),
    });
    expect(ownerSend.status).toBe(200);
  });

  it('PATCH /sessions/:name relays session.restart when ccPreset changes (set or explicitly cleared to null) and validates type', async () => {
    const app = await buildApp();

    // 1. Applying a ccPreset on the same SDK relays session.restart without agentType or session.relabel
    const setRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ccPreset: '  MiniMax  ', requestedModel: 'MiniMax-M2.7', activeModel: null }),
    });
    expect(setRes.status).toBe(200);
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
    const setPayload = JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]));
    expect(setPayload).toEqual({
      type: 'session.restart',
      sessionName: 'deck_proj_brain',
      ccPreset: 'MiniMax',
      requestedModel: 'MiniMax-M2.7',
      activeModel: null,
    });
    sendToDaemonMock.mockClear();

    // 2. Explicitly clearing ccPreset to null relays session.restart with ccPreset: null
    const clearRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code-sdk', ccPreset: null, requestedModel: null, activeModel: null }),
    });
    expect(clearRes.status).toBe(200);
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'session.restart',
      sessionName: 'deck_proj_brain',
      agentType: 'claude-code-sdk',
      ccPreset: null,
      requestedModel: null,
      activeModel: null,
    });
    sendToDaemonMock.mockClear();

    // 3. Invalid non-string non-null ccPreset returns 400
    const badRes = await app.request('/api/server/srv-1/sessions/deck_proj_brain', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ccPreset: 123 }),
    });
    expect(badRes.status).toBe(400);
    expect(await badRes.json()).toEqual({ error: 'invalid_cc_preset' });
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('rejects PUT /sessions/:name without daemon token while allowing shell relabel/rename and P2P targets for whole-server participants', async () => {
    const app = await buildApp();
    const serverCoverage = {
      target: { kind: 'server', serverId: 'srv-1' } as const,
      effectiveRole: 'participant' as const,
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: ['server-share-1'],
      primaryShareId: 'server-share-1',
      authorizedAt: Date.now(),
      serverParticipantAuthority: true,
    };

    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage: serverCoverage },
      shareProvenance: 'server',
    });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant', coverage: serverCoverage },
      shareProvenance: 'server',
    });

    // 1. PUT /sessions/:name cannot persist shell/script or LLM DB rows via share participant without daemon token
    for (const agentType of ['shell', 'script', 'claude-code-sdk']) {
      const putRes = await app.request('/api/server/srv-1/sessions/deck_spoof_brain', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: 'spoof',
          projectRole: 'brain',
          agentType,
          projectDir: '/tmp/spoof',
          state: 'idle',
        }),
      });
      expect(putRes.status).toBe(403);
      expect(await putRes.json()).toEqual({
        error: 'forbidden',
        reason: 'share-direct-surface-denied',
      });
    }
    const delRes = await app.request('/api/server/srv-1/sessions/deck_spoof_brain', { method: 'DELETE' });
    expect(delRes.status).toBe(403);
    expect(mockUpsertDbSession).not.toHaveBeenCalled();

    // 2. PATCH /sessions/:name/label and /rename allowed for share participants on shell sessions (viewer still denied)
    resolveSessionAgentTypeMock.mockResolvedValue('shell');
    const labelRes = await app.request('/api/server/srv-1/sessions/deck_sh_brain/label', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'shared-shell' }),
    });
    expect(labelRes.status).toBe(200);

    const renameRes = await app.request('/api/server/srv-1/sessions/deck_sh_brain/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'shared-shell-project' }),
    });
    expect(renameRes.status).toBe(200);

    mockResolveHttpShareAccessForCoveredSession.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer', coverage: { ...serverCoverage, effectiveRole: 'viewer' } },
      shareProvenance: 'server',
    });
    const viewerRenameRes = await app.request('/api/server/srv-1/sessions/deck_sh_brain/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(viewerRenameRes.status).toBe(403);
    expect(await viewerRenameRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    // 3. Mixed-domain unbounded and explicit shell P2P broadcasts relay with stamped sharedActor
    mockDbQueryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (typeof sql === 'string' && sql.includes('FROM sessions')) {
        return { project_name: params[1] === 'deck_mix_brain' ? 'mix' : 'pure' };
      }
      return { display_name: 'Shared User', username: 'shared' };
    });
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM server_shares')) {
        return [{
          target_kind: 'server',
          id: 'server-share-1',
          server_id: 'srv-1',
          session_name: null,
          sub_session_id: null,
          target_user_id: 'user-1',
          role: 'participant',
          created_by: 'owner-user',
          created_at: 1000,
          updated_at: 1000,
          expires_at: null,
          revoked_at: null,
        }];
      }
      return [];
    });
    resolveSessionAgentTypeMock.mockImplementation(async (name: string) => {
      if (name === 'deck_mix_brain' || name === 'deck_pure_brain') return 'claude-code';
      if (name === 'deck_sub_mixsh') return 'shell';
      if (name === 'deck_sub_mixllm' || name === 'deck_sub_purellm') return 'codex-sdk';
      return null;
    });
    mockGetDbSessionsByServer.mockResolvedValue([
      { name: 'deck_mix_brain', project_name: 'mix', role: 'brain', agent_type: 'claude-code', state: 'idle' },
      { name: 'deck_pure_brain', project_name: 'pure', role: 'brain', agent_type: 'claude-code', state: 'idle' },
    ]);
    mockGetSubSessionsByServer.mockResolvedValue([
      { id: 'mixsh', server_id: 'srv-1', type: 'shell', parent_session: 'deck_mix_brain', closed_at: null },
      { id: 'mixllm', server_id: 'srv-1', type: 'codex-sdk', parent_session: 'deck_mix_brain', closed_at: null },
      { id: 'purellm', server_id: 'srv-1', type: 'codex-sdk', parent_session: 'deck_pure_brain', closed_at: null },
    ]);

    sendToDaemonMock.mockClear();
    for (const payload of [
      { sessionName: 'deck_mix_brain', text: '@@discuss(deck_sub_mixsh, audit)' },
      { sessionName: 'deck_mix_brain', text: 'check', p2pAtTargets: [{ session: 'deck_sub_mixsh', mode: 'audit' }] },
      { sessionName: 'deck_mix_brain', text: 'check', p2pSessionConfig: { deck_sub_mixsh: { enabled: true, mode: 'audit' } } },
    ]) {
      const explicitShell = await app.request('/api/server/srv-1/session/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(explicitShell.status).toBe(200);
    }
    expect(sendToDaemonMock).toHaveBeenCalledTimes(3);
    sendToDaemonMock.mockClear();

    for (const payload of [
      { sessionName: 'deck_mix_brain', text: '@@all(audit)' },
      { sessionName: 'deck_mix_brain', text: 'check', p2pMode: 'audit' },
      { sessionName: 'deck_mix_brain', text: 'check', p2pAtTargets: [{ session: '__all__', mode: 'audit' }] },
      { sessionName: 'deck_pure_brain', text: 'check', p2pMode: 'audit' },
    ]) {
      const bcRes = await app.request('/api/server/srv-1/session/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(bcRes.status).toBe(200);
    }
    expect(sendToDaemonMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toMatchObject({
      type: 'session.send',
      sessionName: 'deck_mix_brain',
      sharedActor: { effectiveActorRole: 'participant', origin: 'shared-server' },
    });
  });
});
