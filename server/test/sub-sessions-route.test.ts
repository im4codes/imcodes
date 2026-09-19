import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';

const createSubSessionMock = vi.fn();
const updateSubSessionMock = vi.fn();
const sendToDaemonMock = vi.fn();
const mockResolveServerMemberAccessOrShareDeny = vi.fn();
const mockResolveHttpShareAccess = vi.fn();
const mockResolveHttpShareAccessForCoveredSession = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('userId', 'test-user');
    return next();
  },
  resolveServerRole: vi.fn().mockResolvedValue('owner'),
}));

vi.mock('../src/routes/share-http-auth.js', () => ({
  resolveServerMemberAccessOrShareDeny: (...args: unknown[]) => mockResolveServerMemberAccessOrShareDeny(...args),
  resolveHttpShareAccess: (...args: unknown[]) => mockResolveHttpShareAccess(...args),
  resolveHttpShareAccessForCoveredSession: (...args: unknown[]) => mockResolveHttpShareAccessForCoveredSession(...args),
}));

vi.mock('../src/db/queries.js', () => ({
  getSubSessionsByServer: vi.fn(),
  getSubSessionById: vi.fn(),
  createSubSession: (...args: unknown[]) => createSubSessionMock(...args),
  updateSubSession: (...args: unknown[]) => updateSubSessionMock(...args),
  deleteSubSession: vi.fn(),
  reorderSubSessions: vi.fn(),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: sendToDaemonMock,
      revalidateShareSocketsForTarget: vi.fn(),
    }),
  },
}));

import { subSessionRoutes } from '../src/routes/sub-sessions.js';

const app = new Hono();
app.use('/*', async (c, next) => {
  (c as any).env = { DB: {} };
  return next();
});
app.route('/api/server', subSessionRoutes);

describe('sub-session routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    createSubSessionMock.mockImplementation(async (_db, id, serverId, type) => ({
      id,
      server_id: serverId,
      type,
      shell_bin: null,
      cwd: '/tmp/test',
      label: 'SDK',
      closed_at: null,
      cc_session_id: null,
      gemini_session_id: null,
      parent_session: 'deck_test_brain',
      sort_order: null,
      runtime_type: null,
      provider_id: null,
      provider_session_id: null,
      description: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      cc_preset_id: null,
      requested_model: null,
      active_model: null,
      effort: null,
      transport_config: {},
    }));
  });

  it('returns only covered sub-sessions to a share-only user', async () => {
    const { getSubSessionsByServer } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionsByServer).mockResolvedValueOnce([
      { id: 'covered' },
      { id: 'private' },
    ] as any);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValueOnce({
      ok: false,
      reason: 'share-direct-surface-denied',
    });
    mockResolveHttpShareAccessForCoveredSession
      .mockResolvedValueOnce({ membership: 'none', actor: { kind: 'share', effectiveActorRole: 'viewer' } })
      .mockResolvedValueOnce({ membership: 'none', actor: { kind: 'none' } });

    const res = await app.request('/api/server/srv1/sub-sessions');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ subSessions: [{ id: 'covered' }] });
  });

  it('accepts claude-code-sdk sub-session type', async () => {
    const res = await app.request('/api/server/srv1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'claude-code-sdk', cwd: '/tmp/test', label: 'CC SDK' }),
    });

    expect(res.status).toBe(201);
    expect(createSubSessionMock).toHaveBeenCalledWith(
      {},
      expect.any(String),
      'srv1',
      'claude-code-sdk',
      null,
      '/tmp/test',
      'CC SDK',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  });

  it('accepts codex-sdk sub-session type', async () => {
    const res = await app.request('/api/server/srv1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk', cwd: '/tmp/test', label: 'Codex SDK' }),
    });

    expect(res.status).toBe(201);
    expect(createSubSessionMock).toHaveBeenCalledWith(
      {},
      expect.any(String),
      'srv1',
      'codex-sdk',
      null,
      '/tmp/test',
      'Codex SDK',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  });

  it('PATCH /sub-sessions/:id relays subsession.restart when type changes', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex',
    } as any);

    const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'codex-sdk',
        cwd: '/tmp/next',
      }),
    });

    expect(res.status).toBe(200);
    expect(updateSubSessionMock).toHaveBeenCalledWith(
      {},
      'sub12345',
      'srv1',
      {
        cwd: '/tmp/next',
      },
    );
    expect(sendToDaemonMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'subsession.restart',
      sessionName: 'deck_sub_sub12345',
      agentType: 'codex-sdk',
      cwd: '/tmp/next',
    });
  });

  it('PATCH /sub-sessions/:id rejects browser-managed closedAt updates', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex',
    } as any);

    const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        closedAt: Date.now(),
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'closed_at_managed_by_daemon' });
    expect(updateSubSessionMock).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('PATCH /sub-sessions/:id relays subsession.rename when only the label changes', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex',
    } as any);

    const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Worker Label',
      }),
    });

    expect(res.status).toBe(200);
    expect(updateSubSessionMock).toHaveBeenCalledWith(
      {},
      'sub12345',
      'srv1',
      {
        label: 'Worker Label',
      },
    );
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: 'subsession.rename',
      sessionName: 'deck_sub_sub12345',
      label: 'Worker Label',
    });
  });

  it('allows a covered share participant to update a sub-session', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex-sdk',
    } as any);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValueOnce({
      ok: false,
      reason: 'share-direct-surface-denied',
    });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });

    const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Participant Label' }),
    });

    expect(res.status).toBe(200);
    expect(updateSubSessionMock).toHaveBeenCalledWith({}, 'sub12345', 'srv1', {
      label: 'Participant Label',
    });
  });

  it('keeps every participant transportConfig shape read-only before DB or daemon mutation', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex-sdk',
      transport_config: { supervision: { mode: 'supervised_audit' } },
    } as any);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({
      ok: false,
      reason: 'share-direct-surface-denied',
    });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });

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
      const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'must-not-mutate-either', transportConfig }),
      });
      expect(res.status, JSON.stringify(transportConfig)).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    }

    expect(updateSubSessionMock).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });

  it('preserves the owner sub-session transportConfig write path', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex-sdk',
      transport_config: {},
    } as any);
    const transportConfig = {
      provider: { mode: 'balanced' },
      supervision: { mode: 'off' },
    };

    const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transportConfig }),
    });

    expect(res.status).toBe(200);
    expect(updateSubSessionMock).toHaveBeenCalledWith({}, 'sub12345', 'srv1', {
      transport_config: transportConfig,
    });
    expect(JSON.parse(String(sendToDaemonMock.mock.calls[0]?.[0]))).toEqual({
      type: DAEMON_COMMAND_TYPES.SUBSESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_sub_sub12345',
      transportConfig,
    });
  });

  it('denies a shared viewer updating a sub-session', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex-sdk',
    } as any);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValueOnce({
      ok: false,
      reason: 'share-direct-surface-denied',
    });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValueOnce({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer' },
    });

    const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Denied Label' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(updateSubSessionMock).not.toHaveBeenCalled();
  });

  it('PATCH /sub-sessions/:id refuses targetless automatic-audit enablement even with a live pool', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub12345',
      server_id: 'srv1',
      type: 'codex-sdk',
    } as any);

    const res = await app.request('/api/server/srv1/sub-sessions/sub12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transportConfig: {
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
        },
      }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', reason: 'brain_session_required' });
    expect(updateSubSessionMock).not.toHaveBeenCalled();
    expect(sendToDaemonMock).not.toHaveBeenCalled();
  });
});
