import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  SESSION_GROUP_CLONE_CAPABILITY_V1,
  SESSION_GROUP_CLONE_MSG,
} from '../../shared/session-group-clone.js';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockSendToDaemon = vi.fn();
const mockHasDaemonCapability = vi.fn(() => true);
const mockLogAudit = vi.fn().mockResolvedValue(undefined);
const mockRegisterCloneContext = vi.fn();
const mockGetCloneOperationEvent = vi.fn(() => null);
const mockGetDbSessionsByServer = vi.fn(async () => []);

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/db/queries.js', () => ({
  getServerById: vi.fn(async () => ({ id: 'srv-1' })),
  getDbSessionsByServer: (...args: unknown[]) => mockGetDbSessionsByServer(...args),
  upsertDbSession: vi.fn(),
  deleteDbSession: vi.fn(),
  updateSessionLabel: vi.fn(),
  updateProjectName: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock('../src/security/crypto.js', () => ({
  randomHex: vi.fn(() => 'sid-test'),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: mockSendToDaemon,
      hasDaemonCapability: mockHasDaemonCapability,
      registerSessionGroupCloneOperationContext: mockRegisterCloneContext,
      getSessionGroupCloneOperationEvent: mockGetCloneOperationEvent,
    }),
  },
}));

vi.mock('../src/util/pod-identity.js', () => ({
  getPodIdentity: vi.fn(() => 'pod-a'),
}));

async function buildApp() {
  const { sessionMgmtRoutes } = await import('../src/routes/session-mgmt.js');
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as unknown as { env: { DB: object } }).env = { DB: {} };
    await next();
  });
  app.route('/api/server', sessionMgmtRoutes);
  return app;
}

describe('session group clone routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveServerRole.mockResolvedValue('owner');
    mockHasDaemonCapability.mockReturnValue(true);
    mockGetCloneOperationEvent.mockReturnValue(null);
    mockGetDbSessionsByServer.mockResolvedValue([]);
  });

  it.each(['owner', 'admin'])('allows %s to start a group clone and forwards the routed payload', async (role) => {
    mockResolveServerRole.mockResolvedValue(role);
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'idem-1',
        targetProjectName: 'P2P Design Review',
        cwdOverride: '/safe/not-audit-path',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockHasDaemonCapability).toHaveBeenCalledWith(SESSION_GROUP_CLONE_CAPABILITY_V1);
    expect(mockSendToDaemon).toHaveBeenCalledTimes(1);
    expect(mockRegisterCloneContext).toHaveBeenCalledWith({
      idempotencyKey: 'idem-1',
      userId: 'user-1',
      sourceMainSessionName: 'deck_cd_brain',
    });
    expect(JSON.parse(String(mockSendToDaemon.mock.calls[0]?.[0]))).toEqual({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId: 'srv-1',
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-1',
      targetProjectName: 'P2P Design Review',
      cwdOverride: '/safe/not-audit-path',
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      serverId: 'srv-1',
      action: 'session_group_clone.accepted',
      details: expect.objectContaining({
        role,
        sourceMainSessionName: 'deck_cd_brain',
        idempotencyKey: 'idem-1',
        targetProjectSlug: 'p2p_design_review',
      }),
    }), {});
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('/safe/not-audit-path');
  });

  it('forwards server-visible session names so daemon default naming can avoid DB-visible conflicts', async () => {
    mockGetDbSessionsByServer.mockResolvedValueOnce([
      { name: 'deck_cd_1_brain' },
      { name: 'deck_other_brain' },
    ]);
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'idem-db-visible' }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(String(mockSendToDaemon.mock.calls[0]?.[0]))).toEqual({
      type: SESSION_GROUP_CLONE_MSG.START,
      serverId: 'srv-1',
      sourceMainSessionName: 'deck_cd_brain',
      idempotencyKey: 'idem-db-visible',
      unavailableSessionNames: ['deck_cd_1_brain', 'deck_other_brain'],
    });
  });

  it('rejects members before daemon forwarding and writes a safe audit log', async () => {
    mockResolveServerRole.mockResolvedValue('member');
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'idem-forbidden',
        targetProjectName: 'cd_1',
        cwdOverride: '/private/source/tree',
      }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'forbidden' });
    expect(mockSendToDaemon).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'session_group_clone.forbidden',
      details: expect.objectContaining({
        role: 'member',
        sourceMainSessionName: 'deck_cd_brain',
        idempotencyKey: 'idem-forbidden',
        targetProjectSlug: 'cd_1',
        errorCode: 'forbidden',
      }),
    }), {});
    expect(JSON.stringify(mockLogAudit.mock.calls)).not.toContain('/private/source/tree');
  });

  it('rejects stale daemons without the clone capability before forwarding', async () => {
    mockHasDaemonCapability.mockReturnValue(false);
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'idem-capability',
        targetProjectName: 'cd_1',
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'unsupported_command',
      missingCapability: SESSION_GROUP_CLONE_CAPABILITY_V1,
    });
    expect(mockSendToDaemon).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'session_group_clone.failed',
      details: expect.objectContaining({
        errorCode: 'unsupported_command',
        missingCapability: SESSION_GROUP_CLONE_CAPABILITY_V1,
      }),
    }), {});
  });

  it('rejects a blank target project name before daemon forwarding', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'idem-blank',
        targetProjectName: '   ',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'blank_target_project' });
    expect(mockSendToDaemon).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'session_group_clone.failed',
      details: expect.objectContaining({
        errorCode: 'blank_target_project',
      }),
    }), {});
  });

  it('requires a nonblank idempotency key before forwarding', async () => {
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetProjectName: 'cd_1',
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_request',
      reason: 'idempotencyKey_required',
    });
    expect(mockSendToDaemon).not.toHaveBeenCalled();
  });

  it('returns an existing daemon operation event for duplicate idempotency keys without forwarding again', async () => {
    const existingEvent = {
      type: SESSION_GROUP_CLONE_MSG.EVENT,
      operationId: 'op-existing',
      idempotencyKey: 'idem-duplicate',
      state: 'creating_main',
      sourceMainSessionName: 'deck_cd_brain',
    };
    mockGetCloneOperationEvent.mockReturnValue(existingEvent);
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'idem-duplicate',
        targetProjectName: 'cd_1',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      duplicate: true,
      event: existingEvent,
    });
    expect(mockSendToDaemon).not.toHaveBeenCalled();
    expect(mockRegisterCloneContext).not.toHaveBeenCalled();
  });

  it('rejects explicit target project names that collide with server-visible sessions', async () => {
    mockGetDbSessionsByServer.mockResolvedValue([{
      name: 'deck_p2p_design_review_brain',
    }]);
    const app = await buildApp();
    const res = await app.request('/api/server/srv-1/sessions/deck_cd_brain/group-clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: 'idem-name-taken',
        targetProjectName: 'P2P Design Review',
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'name_taken',
      targetMainSessionName: 'deck_p2p_design_review_brain',
    });
    expect(mockSendToDaemon).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'session_group_clone.failed',
      details: expect.objectContaining({
        errorCode: 'name_taken',
        targetProjectSlug: 'p2p_design_review',
      }),
    }), {});
  });
});
