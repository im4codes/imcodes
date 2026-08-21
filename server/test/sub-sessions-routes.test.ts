import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
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
});
