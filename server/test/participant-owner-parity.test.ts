import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const mockResolveServerRole = vi.fn<() => Promise<'owner' | 'admin' | 'member' | 'none'>>();
const mockResolveServerMembershipRole = vi.fn<() => Promise<'owner' | 'admin' | 'member' | 'none'>>();
const mockResolveSharedMachineAuthority = vi.fn();
const mockIsSharedOrContributedServer = vi.fn<() => Promise<boolean>>();
const mockGetServerById = vi.fn();
const mockUpdateServerName = vi.fn();
const mockDeleteServer = vi.fn();
const mockSendOutbound = vi.fn();

vi.mock('../src/security/authorization.js', async () => {
  const actual = await vi.importActual<typeof import('../src/security/authorization.js')>('../src/security/authorization.js');
  return {
    ...actual,
    requireAuth: () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'participant-user');
      c.set('role', 'owner');
      await next();
    },
    resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
    resolveServerMembershipRole: (...args: unknown[]) => mockResolveServerMembershipRole(...args as []),
  };
});

vi.mock('../src/security/daemon-auth.js', () => ({
  authenticateDaemonServer: vi.fn(async () => ({
    ok: true,
    auth: { serverId: 'srv-shared', userId: 'owner-user', role: 'owner', nodeRole: NODE_ROLE.FULL },
  })),
  daemonAuthFailure: vi.fn((c: { json: (body: unknown, status: number) => Response }) => c.json({ error: 'unauthorized' }, 401)),
}));

vi.mock('../src/share/shared-machine-authority.js', () => ({
  resolveSharedMachineAuthority: (...args: unknown[]) => mockResolveSharedMachineAuthority(...args),
}));

vi.mock('../src/security/server-share-boundary.js', () => ({
  isSharedOrContributedServer: (...args: unknown[]) => mockIsSharedOrContributedServer(...args as []),
  isWholeServerShareUser: vi.fn(async () => true),
  pauseRevokedSharedCronJobs: vi.fn(async () => {}),
}));

vi.mock('../src/db/queries.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db/queries.js')>('../src/db/queries.js');
  return {
    ...actual,
    getServerById: (...args: unknown[]) => mockGetServerById(...args),
    updateServerName: (...args: unknown[]) => mockUpdateServerName(...args),
    deleteServer: (...args: unknown[]) => mockDeleteServer(...args),
    getServerSharedContextRuntimeConfig: vi.fn(async () => null),
    getPersonalMemorySyncEnabled: vi.fn(async () => false),
  };
});

vi.mock('../src/platform/registry.js', () => ({
  getHandler: vi.fn(() => ({ sendOutbound: (...args: unknown[]) => mockSendOutbound(...args) })),
}));

vi.mock('../src/security/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../src/security/crypto.js')>('../src/security/crypto.js');
  return {
    ...actual,
    decryptBotConfig: vi.fn(() => ({ token: 'bot-tok' })),
  };
});

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: vi.fn(() => ({
      sendToDaemon: vi.fn(),
      daemonUpgradeStatus: vi.fn(() => ({ currentVersion: '0.1.0' })),
      revalidateShareSocketsForUser: vi.fn(async () => {}),
    })),
  },
}));

describe('participant owner-parity vs share-invite denial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    mockResolveServerMembershipRole.mockResolvedValue('none');
    mockResolveSharedMachineAuthority.mockResolvedValue({
      kind: 'participant',
      actorUserId: 'participant-user',
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
    });
    mockIsSharedOrContributedServer.mockResolvedValue(true);
    mockGetServerById.mockResolvedValue({ id: 'srv-shared', user_id: 'owner-user', name: 'Shared Host' });
    mockUpdateServerName.mockResolvedValue(true);
    mockDeleteServer.mockResolvedValue(true);
    mockSendOutbound.mockResolvedValue(undefined);
  });

  it('ownedDaemonServerId grants whole-server participants owner parity while strictly denying viewers and non-members', async () => {
    const { ownedDaemonServerId } = await import('../src/routes/owned-daemon-request.js');
    const app = new Hono();
    app.get('/test', async (c) => {
      c.set('userId' as never, 'participant-user');
      c.env = {
        DB: {
          queryOne: vi.fn(async () => ({ node_role: NODE_ROLE.FULL })),
        } as never,
      } as never;
      const resolved = await ownedDaemonServerId(c as never);
      if ('response' in resolved) return resolved.response;
      return c.json(resolved);
    });

    // Whole-server participant: resolveServerRole === 'owner' even when resolveServerMembershipRole === 'none' -> 200
    const allowedParticipant = await app.request('/test?serverId=srv-shared');
    expect(allowedParticipant.status).toBe(200);
    expect(await allowedParticipant.json()).toEqual({ serverId: 'srv-shared' });

    // Real owner: resolveServerRole === 'owner' -> 200
    mockResolveServerRole.mockResolvedValueOnce('owner');
    const allowedOwner = await app.request('/test?serverId=srv-shared');
    expect(allowedOwner.status).toBe(200);
    expect(await allowedOwner.json()).toEqual({ serverId: 'srv-shared' });

    // Viewer / non-member / session-only share: resolveServerRole === 'none' -> 403
    mockResolveServerRole.mockResolvedValueOnce('none');
    const denied = await app.request('/test?serverId=srv-shared');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden' });
  });

  it('serverRoutes blocks whole-server participant rename/delete and blocks participant_daemon on daemon config/binding routes while keeping runtime-config read', async () => {
    const { serverRoutes } = await import('../src/routes/server.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.env = {
        DB: {
          queryOne: vi.fn(async () => null),
        } as never,
        JWT_SIGNING_KEY: 'secret-key-at-least-32-chars-long!',
      } as never;
      await next();
    });
    app.route('/api/server', serverRoutes);

    const renameRes = await app.request('/api/server/srv-shared/name', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Shared Name' }),
    });
    expect(renameRes.status).toBe(404);
    expect(mockUpdateServerName).not.toHaveBeenCalled();

    const delRes = await app.request('/api/server/srv-shared', { method: 'DELETE' });
    expect(delRes.status).toBe(404);
    expect(mockDeleteServer).not.toHaveBeenCalled();

    const daemonCfgRes = await app.request('/api/server/srv-shared/shared-context/runtime-config/daemon', {
      headers: { [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt' },
    });
    expect(daemonCfgRes.status).toBe(200);

    for (const [method, path, body] of [
      ['GET', '/api/server/srv-shared/supervision/user-defaults/daemon', undefined],
      ['PUT', '/api/server/srv-shared/supervision/user-defaults/daemon', { defaults: {} }],
      ['GET', '/api/server/srv-shared/repo-callbacks/daemon', undefined],
      ['POST', '/api/server/srv-shared/bindings', { platform: 'telegram', channelId: '1', botId: 'b1', bindingType: 'session', target: 'brain' }],
      ['DELETE', '/api/server/srv-shared/bindings', { platform: 'telegram', channelId: '1', botId: 'b1' }],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: {
          [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({ reason: 'shared_participant_forbidden' });
    }

    mockResolveSharedMachineAuthority.mockResolvedValueOnce({ kind: 'invalid', reason: 'bad_sig' });
    const invalidCfgRes = await app.request('/api/server/srv-shared/shared-context/runtime-config/daemon', {
      headers: { [SHARED_MACHINE_AUTHORITY_HEADER]: 'forged' },
    });
    expect(invalidCfgRes.status).toBe(403);
  });

  it('outboundRoutes rejects participant_daemon and platform mismatch while allowing owner_daemon', async () => {
    const { outboundRoutes } = await import('../src/routes/outbound.js');
    let botOwner = 'owner-user';
    let botPlatform = 'telegram';
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.env = {
        DB: {
          queryOne: vi.fn(async () => ({ id: 'bot-1', user_id: botOwner, platform: botPlatform, config_encrypted: 'enc' })),
        } as never,
        JWT_SIGNING_KEY: 'secret-key-at-least-32-chars-long!',
        BOT_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
      } as never;
      await next();
    });
    app.route('/api/outbound', outboundRoutes);

    const partRes = await app.request('/api/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt' },
      body: JSON.stringify({ platform: 'telegram', botId: 'bot-1', channelId: 'ch-1', content: 'hello' }),
    });
    expect(partRes.status).toBe(403);
    expect(await partRes.json()).toMatchObject({ reason: 'shared_participant_forbidden' });
    expect(mockSendOutbound).not.toHaveBeenCalled();

    mockResolveSharedMachineAuthority.mockResolvedValueOnce({ kind: 'owner', actorUserId: 'owner-user' });
    const okRes = await app.request('/api/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'owner-jwt' },
      body: JSON.stringify({ platform: 'telegram', botId: 'bot-1', channelId: 'ch-1', content: 'hello' }),
    });
    expect(okRes.status).toBe(200);
    expect(mockSendOutbound).toHaveBeenCalledTimes(1);

    botPlatform = 'discord';
    mockResolveSharedMachineAuthority.mockResolvedValueOnce({ kind: 'owner', actorUserId: 'owner-user' });
    const platformMismatchRes = await app.request('/api/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'owner-jwt' },
      body: JSON.stringify({ platform: 'telegram', botId: 'bot-1', channelId: 'ch-1', content: 'hello' }),
    });
    expect(platformMismatchRes.status).toBe(403);
    botPlatform = 'telegram';

    botOwner = 'foreign-user';
    mockResolveSharedMachineAuthority.mockResolvedValueOnce({ kind: 'owner', actorUserId: 'owner-user' });
    const foreignRes = await app.request('/api/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'owner-jwt' },
      body: JSON.stringify({ platform: 'telegram', botId: 'bot-1', channelId: 'ch-1', content: 'hello' }),
    });
    expect(foreignRes.status).toBe(403);

    mockResolveSharedMachineAuthority.mockResolvedValueOnce({ kind: 'invalid', reason: 'bad_sig' });
    const invalidRes = await app.request('/api/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'bad' },
      body: JSON.stringify({ platform: 'telegram', botId: 'bot-1', channelId: 'ch-1', content: 'hello' }),
    });
    expect(invalidRes.status).toBe(403);
  });

  it('tabSharingRoutes strictly denies whole-server participants from listing, inviting, updating, or revoking shares', async () => {
    const { tabSharingRoutes } = await import('../src/routes/tab-sharing.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.env = {
        DB: {
          queryOne: vi.fn(async () => ({ user_id: 'owner-user', node_role: NODE_ROLE.FULL })),
          execute: vi.fn(async () => ({ changes: 1 })),
        } as never,
      } as never;
      await next();
    });
    app.route('/api', tabSharingRoutes);

    expect((await app.request('/api/server/srv-shared/shares')).status).toBe(403);
    expect((await app.request('/api/server/srv-shared/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'server', serverId: 'srv-shared' }, targetUserId: 'viewer-user', role: 'viewer' }),
    })).status).toBe(403);
    expect((await app.request('/api/server/srv-shared/shares/share-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'participant' }),
    })).status).toBe(403);
    expect((await app.request('/api/server/srv-shared/shares/share-1', {
      method: 'DELETE',
    })).status).toBe(403);
    expect((await app.request('/api/server/srv-shared/share-audit')).status).toBe(403);
  });

  it('serverRoutes owner-private write and search reject participant_daemon and bare shared-host daemon tokens at route level', async () => {
    const { serverRoutes } = await import('../src/routes/server.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.env = {
        DB: {
          queryOne: vi.fn(async () => null),
          execute: vi.fn(async () => ({ changes: 1 })),
        } as never,
        JWT_SIGNING_KEY: 'secret-key-at-least-32-chars-long!',
      } as never;
      await next();
    });
    app.route('/api/server', serverRoutes);

    const writeRes = await app.request('/api/server/srv-shared/shared-context/owner-private', {
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-tok', 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt' },
      body: JSON.stringify({ namespace: { scope: 'user_private', userId: 'owner-user' }, records: [] }),
    });
    expect(writeRes.status).toBe(403);
    expect(await writeRes.json()).toMatchObject({ reason: 'shared_participant_forbidden' });

    const searchRes = await app.request('/api/server/srv-shared/shared-context/owner-private/search', {
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-tok', 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt' },
      body: JSON.stringify({ query: 'secret' }),
    });
    expect(searchRes.status).toBe(403);
    expect(await searchRes.json()).toMatchObject({ reason: 'shared_participant_forbidden' });

    mockResolveSharedMachineAuthority.mockResolvedValue({ kind: 'absent' });
    mockIsSharedOrContributedServer.mockResolvedValueOnce(true);
    const bareRes = await app.request('/api/server/srv-shared/shared-context/owner-private/search', {
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'secret' }),
    });
    expect(bareRes.status).toBe(403);
    expect(await bareRes.json()).toMatchObject({ reason: 'shared_host_daemon_authority_required' });
  });

  it('serverRoutes shared-context/processed rejects participant personal writes without DB write while allowing project_shared parity and scoping resolve-namespace to participant actor', async () => {
    const { serverRoutes } = await import('../src/routes/server.js');
    const executeSpy = vi.fn(async () => ({ changes: 1 }));
    const queryOneSpy = vi.fn(async () => null);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.env = {
        DB: {
          queryOne: queryOneSpy,
          execute: executeSpy,
        } as never,
        JWT_SIGNING_KEY: 'secret-key-at-least-32-chars-long!',
      } as never;
      await next();
    });
    app.route('/api/server', serverRoutes);

    // 1. Participant submitting personal projection (even omitting userId or mixed with shared) -> 403, zero DB writes
    mockResolveSharedMachineAuthority.mockResolvedValue({
      kind: 'participant',
      actorUserId: 'participant-user',
      sourceServerId: 'srv-shared',
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
    });
    const partPersonalRes = await app.request('/api/server/srv-shared/shared-context/processed', {
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-tok', 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt' },
      body: JSON.stringify({
        namespace: { scope: 'personal', projectId: 'proj-1' },
        projections: [
          {
            id: 'proj-shared-ok',
            namespace: { scope: 'project_shared', projectId: 'proj-1' },
            class: 'recent_summary',
            origin: 'chat_compacted',
            sourceEventIds: [],
            summary: 'shared team summary',
            content: {},
            createdAt: 100,
            updatedAt: 100,
          },
          {
            id: 'proj-owner-poison',
            namespace: { scope: 'personal', projectId: 'proj-1' },
            class: 'durable_memory_candidate',
            origin: 'chat_compacted',
            sourceEventIds: [],
            summary: 'poisoned owner personal memory',
            content: {},
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      }),
    });
    expect(partPersonalRes.status).toBe(403);
    expect(await partPersonalRes.json()).toMatchObject({ reason: 'shared_participant_forbidden' });
    expect(executeSpy).not.toHaveBeenCalled();

    // 2. Participant submitting project_shared projection succeeds and never attributes user_id to owner-user
    const partSharedRes = await app.request('/api/server/srv-shared/shared-context/processed', {
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-tok', 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt' },
      body: JSON.stringify({
        namespace: { scope: 'project_shared', projectId: 'proj-1' },
        projections: [
          {
            id: 'proj-shared-1',
            namespace: { scope: 'project_shared', projectId: 'proj-1', userId: 'owner-user' },
            class: 'recent_summary',
            origin: 'chat_compacted',
            sourceEventIds: [],
            summary: 'shared project progress summary',
            content: {},
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      }),
    });
    expect(partSharedRes.status).toBe(200);
    expect(executeSpy).toHaveBeenCalled();
    const insertParams = executeSpy.mock.calls[0]?.[1] as unknown[];
    expect(insertParams[5]).toBe('participant-user');

    // 3. Bare shared-host daemon submitting personal projection -> 403, zero DB writes
    executeSpy.mockClear();
    mockResolveSharedMachineAuthority.mockResolvedValue({ kind: 'absent' });
    mockIsSharedOrContributedServer.mockResolvedValueOnce(true);
    const barePersonalRes = await app.request('/api/server/srv-shared/shared-context/processed', {
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: { scope: 'personal', projectId: 'proj-1', userId: 'owner-user' },
        projections: [
          {
            id: 'proj-bare-poison',
            namespace: { scope: 'personal', projectId: 'proj-1', userId: 'owner-user' },
            class: 'recent_summary',
            origin: 'chat_compacted',
            sourceEventIds: [],
            summary: 'bare shared poison',
            content: {},
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      }),
    });
    expect(barePersonalRes.status).toBe(403);
    expect(await barePersonalRes.json()).toMatchObject({ reason: 'shared_host_daemon_authority_required' });
    expect(executeSpy).not.toHaveBeenCalled();

    // 4. resolve-namespace with participant authority queries participant-user, never owner-user
    queryOneSpy.mockClear();
    mockResolveSharedMachineAuthority.mockResolvedValue({
      kind: 'participant',
      actorUserId: 'participant-user',
      sourceServerId: 'srv-shared',
      sessionName: 'deck_proj_brain',
      projectName: 'proj',
    });
    const resolvePartRes = await app.request('/api/server/srv-shared/shared-context/resolve-namespace', {
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-tok', 'Content-Type': 'application/json', [SHARED_MACHINE_AUTHORITY_HEADER]: 'part-jwt' },
      body: JSON.stringify({ canonicalRepoId: 'github.com/org/repo' }),
    });
    expect(resolvePartRes.status).toBe(200);
    const personalQueryCall = queryOneSpy.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes("scope = 'personal'"));
    expect(personalQueryCall?.[1]).toEqual(['participant-user', 'github.com/org/repo']);
  });
});
