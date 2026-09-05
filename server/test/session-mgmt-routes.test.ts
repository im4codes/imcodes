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

vi.mock('../src/security/crypto.js', () => ({
  randomHex: vi.fn(() => 'sid-test'),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: sendToDaemonMock,
      countSharePendingCommandsForUser: countSharePendingCommandsForUserMock,
      getActiveDispatchIdForSession: getActiveDispatchIdForSessionMock,
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
    mockGetUserPref.mockResolvedValue(null);
    mockSetUserPref.mockResolvedValue(undefined);
  });

  async function buildApp() {
    const { sessionMgmtRoutes } = await import('../src/routes/session-mgmt.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object } }).env = { DB: mockDb };
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
      body: JSON.stringify({ sessionName: 'deck_proj_brain', commandId: 'cancel-1', text: '/stop' }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL,
      sessionName: 'deck_proj_brain',
      commandId: 'cancel-1',
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

  it('PATCH /sessions/:name/supervision keeps covered participants read-only', async () => {
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
      transport_config: {
        provider: { privateSetting: 'preserved' },
        supervision: {
          mode: 'off',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 45_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
    });
    const app = await buildApp();

    for (const mode of ['off', 'supervised', 'supervised_audit'] as const) {
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
            ...(mode === 'supervised_audit' ? {
              maxAuditLoops: 2,
              taskRunPromptVersion: 'task_run_status_v1',
              executionPools: {
                state: 'configured',
                primaryDevelopmentPool: {
                  configs: [{
                    capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.4',
                    agentType: 'codex-sdk',
                    providerFamily: 'openai',
                    runtimeType: 'transport',
                    model: 'gpt-5.4',
                  }],
                  controls: {},
                },
                economyTaskPool: { configs: [], controls: {} },
              },
            } : {}),
          },
        }),
      });

      expect(res.status, mode).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    }
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(mockUpdateSubSession).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
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

  it('PATCH /sessions/:name/supervision denies a participant before inspecting a forged audit target', async () => {
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
          model: 'gpt-5.4',
          timeoutMs: 30_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
          auditTargetSessionName: 'deck_other_brain',
        },
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'forbidden',
      reason: 'share-role-denied',
    });
    expect(mockUpdateSession).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
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
          backend: 'qwen',
          model: 'MiniMax-M2.7',
          preset: 'MiniMax Owner',
          timeoutMs: 55_000,
          promptVersion: 'supervision_decision_v1',
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
      backend: 'qwen',
      model: 'MiniMax-M2.7',
      preset: 'MiniMax Owner',
    }));
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
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
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
        observedDispatchId: 'dispatch-1',
        text: '/stop',
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL,
      sessionName: 'deck_proj_brain',
      commandId: 'cancel-1',
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

  it('POST /session/cancel rejects shared transport cancel without observedDispatchId', async () => {
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
    await expect(res.json()).resolves.toEqual({ error: 'not_canceled', reason: 'share-target-unavailable' });
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
    await expect(res.json()).resolves.toEqual({ error: 'not_canceled', reason: 'share-target-unavailable' });
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
});
