import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockResolveServerMembershipRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockResolveServerMemberAccessOrShareDeny = vi.fn();
const mockResolveHttpShareAccess = vi.fn();
const mockResolveHttpShareAccessForCoveredSession = vi.fn();
const mockCreateSubSession = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
  resolveServerMembershipRole: (...args: unknown[]) => mockResolveServerMembershipRole(...args as []),
}));

vi.mock('../src/routes/share-http-auth.js', () => ({
  resolveServerMemberAccessOrShareDeny: (...args: unknown[]) => mockResolveServerMemberAccessOrShareDeny(...args),
  resolveHttpShareAccess: (...args: unknown[]) => mockResolveHttpShareAccess(...args),
  resolveHttpShareAccessForCoveredSession: (...args: unknown[]) => mockResolveHttpShareAccessForCoveredSession(...args),
}));

vi.mock('../src/db/queries.js', () => ({
  getSubSessionsByServer: vi.fn(async () => []),
  getSubSessionById: vi.fn(async () => null),
  createSubSession: (...args: unknown[]) => mockCreateSubSession(...args),
  updateSubSession: vi.fn(),
  deleteSubSession: vi.fn(),
  reorderSubSessions: vi.fn(),
}));

describe('sub-session routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    mockResolveServerMembershipRole.mockResolvedValue('owner');
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'owner',
      actor: { kind: 'server-member', effectiveActorRole: 'server-manager' },
    });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'owner',
      actor: { kind: 'server-member', effectiveActorRole: 'server-manager' },
    });
    mockCreateSubSession.mockResolvedValue({ id: 'child123', server_id: 'srv-1' });
  });

  async function buildApp() {
    const { subSessionRoutes } = await import('../src/routes/sub-sessions.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object } }).env = { DB: {} };
      await next();
    });
    app.route('/api/server', subSessionRoutes);
    return app;
  }

  it('POST /sub-sessions rejects known test sub-session shapes before DB creation', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'copilot-sdk',
        cwd: '/tmp/bootmain-e2e',
        parent_session: 'deck_bootmainabc123_brain',
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'test_session_blocked' });
    expect(mockCreateSubSession).not.toHaveBeenCalled();
  });

  it('allows a share participant to create a child under a covered main session', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk', parent_session: 'deck_project_brain' }),
    });

    expect(res.status).toBe(201);
    expect(mockResolveHttpShareAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serverId: 'srv-1',
      userId: 'user-1',
      target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_project_brain' },
    }));
    expect(mockCreateSubSession).toHaveBeenCalled();
  });

  it('allows a share participant to create a child under a covered sub-session', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk', parent_session: 'deck_sub_abc12345' }),
    });

    expect(res.status).toBe(201);
    expect(mockResolveHttpShareAccessForCoveredSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serverId: 'srv-1',
      userId: 'user-1',
      target: { kind: 'subsession', serverId: 'srv-1', subSessionId: 'abc12345' },
    }));
    expect(mockCreateSubSession).toHaveBeenCalled();
  });

  it('allows a whole-server participant to create a sub-session when parent_session is omitted', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk' }),
    });

    expect(res.status).toBe(201);
    expect(mockResolveHttpShareAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serverId: 'srv-1',
      userId: 'user-1',
      target: { kind: 'server', serverId: 'srv-1' },
    }));
    expect(mockCreateSubSession).toHaveBeenCalled();
  });

  it('denies a shared viewer creating a sub-session', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer' },
    });
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk', parent_session: 'deck_project_brain' }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(mockCreateSubSession).not.toHaveBeenCalled();
  });

  it('does not authorize an unauthorized explicit parent_session via Step 3 fallback', async () => {
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'none' },
    });
    const app = await buildApp();
    (app as unknown as { request: unknown });
    const { subSessionRoutes } = await import('../src/routes/sub-sessions.js');
    const customApp = new Hono();
    customApp.use('*', async (c, next) => {
      (c as unknown as { env: { DB: object } }).env = {
        DB: {
          query: vi.fn(async () => [{
            id: 'share-other',
            server_id: 'srv-1',
            target_kind: 'main',
            session_name: 'deck_allowed_brain',
            target_user_id: 'user-1',
            role: 'participant',
            created_at: 1,
            updated_at: 1,
            expires_at: null,
            revoked_at: null,
          }]),
        },
      };
      await next();
    });
    customApp.route('/api/server', subSessionRoutes);

    const res = await customApp.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'codex-sdk', parent_session: 'deck_unshared_brain' }),
    });

    expect(res.status).toBe(403);
    expect(mockCreateSubSession).not.toHaveBeenCalled();
  });

  it('allows browser-shaped transport_config: null for main and sub-session share participants while rejecting non-null transport_config for all share participants (including whole-server) and allowing direct owner', async () => {
    const app = await buildApp();

    // 1) Main share participant with browser default transport_config: null -> 201
    mockResolveServerMembershipRole.mockResolvedValue('none');
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'session',
    });
    const mainNullRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'codex-sdk',
        parent_session: 'deck_project_brain',
        transport_config: null,
      }),
    });
    expect(mainNullRes.status).toBe(201);
    expect(mockCreateSubSession).toHaveBeenCalledTimes(1);

    // 2) Sub-session share participant with browser default transport_config: null -> 201
    mockCreateSubSession.mockClear();
    const subNullRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'codex-sdk',
        parent_session: 'deck_sub_allowed1',
        transport_config: null,
      }),
    });
    expect(subNullRes.status).toBe(201);
    expect(mockCreateSubSession).toHaveBeenCalledTimes(1);

    // 3) Main share participant with non-null transport_config -> 403
    mockCreateSubSession.mockClear();
    const mainNonNullRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'codex-sdk',
        parent_session: 'deck_project_brain',
        transport_config: { supervision: { mode: 'supervised' } },
      }),
    });
    expect(mainNonNullRes.status).toBe(403);
    expect(await mainNonNullRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(mockCreateSubSession).not.toHaveBeenCalled();

    // 4) Whole-server share participant (member.ok === true via resolveServerRole, but resolveServerMembershipRole === 'none'):
    //    transport_config: null -> 201; non-null transport_config -> 403
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'server',
    });
    const wholeNullRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'codex-sdk',
        parent_session: 'deck_project_brain',
        transport_config: null,
      }),
    });
    expect(wholeNullRes.status).toBe(201);

    mockCreateSubSession.mockClear();
    const wholeNonNullRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'codex-sdk',
        parent_session: 'deck_project_brain',
        transport_config: { supervision: { mode: 'supervised' } },
      }),
    });
    expect(wholeNonNullRes.status).toBe(403);
    expect(await wholeNonNullRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(mockCreateSubSession).not.toHaveBeenCalled();

    // 5) Direct server owner positive control with non-null transport_config -> 201
    mockResolveServerMembershipRole.mockResolvedValue('owner');
    const ownerRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'codex-sdk',
        parent_session: 'deck_project_brain',
        transport_config: { supervision: { mode: 'supervised' } },
      }),
    });
    expect(ownerRes.status).toBe(201);
    expect(mockCreateSubSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSubSession.mock.calls[0]?.[18]).toEqual({ supervision: { mode: 'supervised' } });
  });

  it('rejects cwd changes and shell/script type switches on PATCH /sub-sessions/:subId for single-session shares', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'abc12345',
      server_id: 'srv-1',
      type: 'codex-sdk',
    } as never);
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'session',
    });
    const app = await buildApp();

    const cwdRes = await app.request('/api/server/srv-1/sub-sessions/abc12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/etc' }),
    });
    expect(cwdRes.status).toBe(403);
    expect(await cwdRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });

    for (const type of ['shell', 'script']) {
      const typeRes = await app.request('/api/server/srv-1/sub-sessions/abc12345', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      expect(typeRes.status).toBe(200);
    }
  });

  it('allows tab-share and whole-server-share participants to create and mutate shell/script sub-sessions while keeping viewers denied', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    const app = await buildApp();

    // 1) Tab-share participant POST shell/script & LLM -> 201
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'session',
    });
    for (const type of ['shell', 'script', 'codex-sdk']) {
      mockCreateSubSession.mockClear();
      const res = await app.request('/api/server/srv-1/sub-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, parent_session: 'deck_project_brain' }),
      });
      expect(res.status).toBe(201);
      expect(mockCreateSubSession).toHaveBeenCalledTimes(1);
    }

    // Viewer remains blocked on POST shell/script (must use persistent mockResolvedValue across main + server fallback checks)
    mockCreateSubSession.mockClear();
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'viewer' },
      shareProvenance: 'session',
    });
    const viewerPostRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'shell', parent_session: 'deck_project_brain' }),
    });
    expect(viewerPostRes.status).toBe(403);
    expect(await viewerPostRes.json()).toEqual({ error: 'forbidden', reason: 'share-role-denied' });
    expect(mockCreateSubSession).not.toHaveBeenCalled();

    // 2) Whole-server share participant POST shell/script & LLM -> 201
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveServerMembershipRole.mockResolvedValue('none');
    mockResolveHttpShareAccess.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'server',
    });
    for (const type of ['shell', 'script', 'claude-code']) {
      mockCreateSubSession.mockClear();
      const res = await app.request('/api/server/srv-1/sub-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, parent_session: 'deck_project_brain' }),
      });
      expect(res.status).toBe(201);
      expect(mockCreateSubSession).toHaveBeenCalledTimes(1);
    }

    // 3) PATCH switching to shell/script or mutating an existing shell/script sub-session -> 200
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub-shell-1',
      server_id: 'srv-1',
      type: 'shell',
    } as never);
    const wholeExistingShellPatch = await app.request('/api/server/srv-1/sub-sessions/sub-shell-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'renamed' }),
    });
    expect(wholeExistingShellPatch.status).toBe(200);

    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub-llm-1',
      server_id: 'srv-1',
      type: 'codex-sdk',
    } as never);
    for (const type of ['shell', 'script']) {
      const wholeSwitchPatch = await app.request('/api/server/srv-1/sub-sessions/sub-llm-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      expect(wholeSwitchPatch.status).toBe(200);
    }

    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
    mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
      membership: 'none',
      actor: { kind: 'share', effectiveActorRole: 'participant' },
      shareProvenance: 'session',
    });
    vi.mocked(getSubSessionById).mockResolvedValue({
      id: 'sub-script-1',
      server_id: 'srv-1',
      type: 'script',
    } as never);
    const tabExistingScriptPatch = await app.request('/api/server/srv-1/sub-sessions/sub-script-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'renamed' }),
    });
    expect(tabExistingScriptPatch.status).toBe(200);

    // 4) Real owner still allowed to create shell/script sub-session
    mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
    mockResolveServerMembershipRole.mockResolvedValue('owner');
    const ownerShellRes = await app.request('/api/server/srv-1/sub-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'shell', parent_session: 'deck_project_brain' }),
    });
    expect(ownerShellRes.status).toBe(201);
  });

  it('stamps sharedActor on participant PATCH sub-session restarts including when live daemon type is shell', async () => {
    const { getSubSessionById } = await import('../src/db/queries.js');
    const { WsBridge } = await import('../src/ws/bridge.js');
    const bridge = WsBridge.get('srv-1');
    const sendSpy = vi.spyOn(bridge, 'sendToDaemon').mockImplementation(() => {});
    const liveTypeSpy = vi.spyOn(bridge, 'resolveSessionAgentType').mockResolvedValue(null);
    const invalidateSpy = vi.spyOn(bridge, 'invalidateSessionAgentTypeCache');
    try {
      const app = await buildApp();

      // 1) Tab-share participant allowed LLM type switch -> relays subsession.restart with sharedActor
      mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: false, reason: 'share-direct-surface-denied' });
      mockResolveHttpShareAccessForCoveredSession.mockResolvedValue({
        membership: 'none',
        actor: {
          kind: 'share',
          effectiveActorRole: 'participant',
          coverage: {
            target: { kind: 'subsession', serverId: 'srv-1', subSessionId: 'sub-llm-1' },
            effectiveRole: 'participant',
            historyCutoffAt: 0,
            nextCoverageRecheckAt: null,
            coveringShareIds: ['tab-1'],
            primaryShareId: 'tab-1',
            authorizedAt: 1000,
          },
        },
        shareProvenance: 'session',
      });
      vi.mocked(getSubSessionById).mockResolvedValue({
        id: 'sub-llm-1',
        server_id: 'srv-1',
        type: 'codex-sdk',
      } as never);

      const tabPatch = await app.request('/api/server/srv-1/sub-sessions/sub-llm-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'claude-code-sdk' }),
      });
      expect(tabPatch.status).toBe(200);
      expect(invalidateSpy).toHaveBeenCalledWith('deck_sub_sub-llm-1');
      expect(JSON.parse(String(sendSpy.mock.calls[0]?.[0]))).toMatchObject({
        type: 'subsession.restart',
        sessionName: 'deck_sub_sub-llm-1',
        agentType: 'claude-code-sdk',
        sharedActor: { effectiveActorRole: 'participant', origin: 'shared-tab' },
      });

      // 2) Whole-server participant allowed LLM type switch -> relays with shared-server actor
      sendSpy.mockClear();
      mockResolveServerMemberAccessOrShareDeny.mockResolvedValue({ ok: true, role: 'owner' });
      mockResolveServerMembershipRole.mockResolvedValue('none');
      mockResolveHttpShareAccess.mockResolvedValue({
        membership: 'none',
        actor: {
          kind: 'share',
          effectiveActorRole: 'participant',
          coverage: {
            target: { kind: 'server', serverId: 'srv-1' },
            effectiveRole: 'participant',
            historyCutoffAt: 0,
            nextCoverageRecheckAt: null,
            coveringShareIds: ['srv-share-1'],
            primaryShareId: 'srv-share-1',
            authorizedAt: 1000,
            serverParticipantAuthority: true,
          },
        },
        shareProvenance: 'server',
      });
      const srvPatch = await app.request('/api/server/srv-1/sub-sessions/sub-llm-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'codex-sdk' }),
      });
      expect(srvPatch.status).toBe(200);
      expect(JSON.parse(String(sendSpy.mock.calls[0]?.[0]))).toMatchObject({
        type: 'subsession.restart',
        sessionName: 'deck_sub_sub-llm-1',
        agentType: 'codex-sdk',
        sharedActor: { effectiveActorRole: 'participant', origin: 'shared-server' },
      });

      // 3) Live bridge type is shell -> still allowed and stamped with sharedActor
      sendSpy.mockClear();
      liveTypeSpy.mockResolvedValueOnce('shell');
      const mismatchRes = await app.request('/api/server/srv-1/sub-sessions/sub-llm-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'claude-code-sdk' }),
      });
      expect(mismatchRes.status).toBe(200);
      expect(JSON.parse(String(sendSpy.mock.calls[0]?.[0]))).toMatchObject({
        type: 'subsession.restart',
        sessionName: 'deck_sub_sub-llm-1',
        agentType: 'claude-code-sdk',
        sharedActor: { effectiveActorRole: 'participant', origin: 'shared-server' },
      });
    } finally {
      sendSpy.mockRestore();
      liveTypeSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });

  it('PATCH /sub-sessions/:subId updates cc_preset_id and relays subsession.restart on ccPresetId set/clear', async () => {
    const { getSubSessionById, updateSubSession } = await import('../src/db/queries.js');
    const { WsBridge } = await import('../src/ws/bridge.js');
    const bridge = WsBridge.get('srv-1');
    const sendSpy = vi.spyOn(bridge, 'sendToDaemon').mockImplementation(() => {});
    try {
      vi.mocked(getSubSessionById).mockResolvedValue({
        id: 'sub-cc-1',
        server_id: 'srv-1',
        type: 'claude-code-sdk',
      } as never);
      const app = await buildApp();

      // 1. Set ccPresetId -> updates DB and relays subsession.restart with ccPreset
      const setRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ccPresetId: ' MiniMax ', requestedModel: 'MiniMax-M2.7', activeModel: null }),
      });
      expect(setRes.status).toBe(200);
      expect(updateSubSession).toHaveBeenCalledWith(expect.anything(), 'sub-cc-1', 'srv-1', {
        cc_preset_id: 'MiniMax',
        requested_model: 'MiniMax-M2.7',
        active_model: null,
      });
      expect(JSON.parse(String(sendSpy.mock.calls[0]?.[0]))).toEqual({
        type: 'subsession.restart',
        sessionName: 'deck_sub_sub-cc-1',
        ccPreset: 'MiniMax',
        requestedModel: 'MiniMax-M2.7',
        activeModel: null,
      });
      sendSpy.mockClear();

      // 2. Clear ccPresetId -> sets null in DB and relays subsession.restart with ccPreset: null
      const clearRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'claude-code-sdk', ccPresetId: null, requestedModel: null, activeModel: null }),
      });
      expect(clearRes.status).toBe(200);
      expect(updateSubSession).toHaveBeenLastCalledWith(expect.anything(), 'sub-cc-1', 'srv-1', {
        cc_preset_id: null,
        requested_model: null,
        active_model: null,
      });
      expect(JSON.parse(String(sendSpy.mock.calls[0]?.[0]))).toEqual({
        type: 'subsession.restart',
        sessionName: 'deck_sub_sub-cc-1',
        agentType: 'claude-code-sdk',
        ccPreset: null,
        requestedModel: null,
        activeModel: null,
      });
      sendSpy.mockClear();

      // 3. Invalid ccPresetId returns 400
      const badRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ccPresetId: 42 }),
      });
      expect(badRes.status).toBe(400);
      expect(await badRes.json()).toEqual({ error: 'invalid_cc_preset' });
      expect(sendSpy).not.toHaveBeenCalled();

      // 4. Daemon restart rejection returns 422 BEFORE updating sub_sessions DB
      vi.mocked(updateSubSession).mockClear();
      const restartCmdSpy = vi.spyOn(bridge, 'sendSessionRestartCommand').mockResolvedValue({
        status: 'rejected',
        error: 'Cannot safely forward model "m %TEMP%" through unparsed Windows batch file',
      });
      try {
        const rejectRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'claude-code',
            ccPresetId: 'MiniMax',
            requestedModel: 'm %TEMP%',
            activeModel: null,
          }),
        });
        expect(rejectRes.status).toBe(422);
        expect(await rejectRes.json()).toEqual({
          error: 'Cannot safely forward model "m %TEMP%" through unparsed Windows batch file',
        });
        expect(restartCmdSpy).toHaveBeenCalledTimes(1);
        expect(updateSubSession).not.toHaveBeenCalled();

        // 5. Daemon fallback commit persists actual m1 / activeModel=m1 (never raw m2 / null) and explicit null clear
        const appliedFallback = {
          agentType: 'qwen',
          ccPreset: null,
          requestedModel: 'm1',
          activeModel: 'm1',
          modelDisplay: 'm1',
          runtimeType: 'transport',
          providerId: 'qwen',
          cwd: '/cc',
          label: null,
          description: null,
          effort: null,
          transportConfig: null,
          runtimeEpoch: 'epoch-sub-1',
        };
        restartCmdSpy.mockImplementationOnce(async (_frame, opts) => {
          await opts?.persistApplied?.(appliedFallback);
          return { status: 'committed', applied: appliedFallback };
        });
        const appliedRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'qwen',
            ccPresetId: null,
            requestedModel: 'm2',
            activeModel: null,
          }),
        });
        expect(appliedRes.status).toBe(200);
        expect(await appliedRes.json()).toEqual({ ok: true, applied: appliedFallback });
        expect(updateSubSession).toHaveBeenCalledWith(expect.anything(), 'sub-cc-1', 'srv-1', expect.objectContaining({
          type: 'qwen',
          cc_preset_id: null,
          requested_model: 'm1',
          active_model: 'm1',
        }));

        // 6. Pending timeout returns 202 without overwriting DB prematurely
        vi.mocked(updateSubSession).mockClear();
        restartCmdSpy.mockResolvedValueOnce({
          status: 'pending',
          requestId: 'req-sub-pending',
          restartEpoch: 3,
        });
        const pendingRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'claude-code',
            ccPresetId: null,
            requestedModel: null,
          }),
        });
        expect(pendingRes.status).toBe(202);
        expect(await pendingRes.json()).toEqual({ ok: false, pending: true, requestId: 'req-sub-pending' });
        expect(updateSubSession).not.toHaveBeenCalled();

        // 7. Superseded -> 200 { ok: false, superseded: true } without calling updateSubSession
        vi.mocked(updateSubSession).mockClear();
        restartCmdSpy.mockResolvedValueOnce({ status: 'superseded' });
        const supRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'qwen',
            ccPresetId: 'MiniMax',
            requestedModel: 'stale-m',
          }),
        });
        expect(supRes.status).toBe(200);
        expect(await supRes.json()).toEqual({ ok: false, superseded: true });
        expect(updateSubSession).not.toHaveBeenCalled();

        // 8. Plain type switch WITHOUT ccPresetId bypasses sendSessionRestartCommand and relays via sendToDaemon
        vi.mocked(updateSubSession).mockClear();
        restartCmdSpy.mockClear();
        sendSpy.mockClear();
        const plainRes = await app.request('/api/server/srv-1/sub-sessions/sub-cc-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'codex-sdk',
            requestedModel: 'gpt-5',
          }),
        });
        expect(plainRes.status).toBe(200);
        expect(await plainRes.json()).toEqual({ ok: true });
        expect(restartCmdSpy).not.toHaveBeenCalled();
        expect(updateSubSession).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(sendSpy.mock.calls[0]?.[0]))).toEqual({
          type: 'subsession.restart',
          sessionName: 'deck_sub_sub-cc-1',
          agentType: 'codex-sdk',
          requestedModel: 'gpt-5',
        });
      } finally {
        restartCmdSpy.mockRestore();
      }
    } finally {
      sendSpy.mockRestore();
    }
  });
});
