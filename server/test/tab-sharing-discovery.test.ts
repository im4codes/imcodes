import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mockListActiveSharesForUser = vi.fn();

vi.mock('../src/security/authorization.js', async () => {
  const actual = await vi.importActual<typeof import('../src/security/authorization.js')>('../src/security/authorization.js');
  return {
    ...actual,
    requireAuth: () => async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.set('userId', 'recipient-1');
      c.set('role', 'owner');
      await next();
    },
  };
});

vi.mock('../src/db/tab-sharing.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db/tab-sharing.js')>('../src/db/tab-sharing.js');
  return {
    ...actual,
    listActiveSharesForUser: (...args: unknown[]) => mockListActiveSharesForUser(...args),
  };
});

describe('GET /api/shares discovery metadata', () => {
  it('projects sessionState, agentType, and parentSessionName with a single query per share', async () => {
    const { tabSharingRoutes } = await import('../src/routes/tab-sharing.js');
    mockListActiveSharesForUser.mockResolvedValueOnce([
      {
        id: 'share-server',
        serverId: 'srv-1',
        target: { kind: 'server', serverId: 'srv-1' },
        role: 'viewer',
        expiresAt: 0,
      },
      {
        id: 'share-main',
        serverId: 'srv-1',
        target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_projA_brain' },
        role: 'participant',
        expiresAt: 0,
      },
      {
        id: 'share-sub',
        serverId: 'srv-1',
        target: { kind: 'subsession', serverId: 'srv-1', subSessionId: 'sub42' },
        role: 'viewer',
        expiresAt: 0,
      },
    ]);

    const queryOne = vi.fn(async (sql: string) => {
      if (sql.includes('FROM servers WHERE id')) {
        return { name: 'Server One', node_role: 'full', status: 'online', last_heartbeat_at: 123_456 };
      }
      if (sql.includes('FROM sessions s')) {
        return {
          server_name: 'Server One',
          label: 'Project A',
          project_name: 'projA',
          session_state: 'running',
          agent_type: 'claude-code',
          status: 'online',
          last_heartbeat_at: 123_456,
        };
      }
      if (sql.includes('FROM sub_sessions ss')) {
        return {
          server_name: 'Server One',
          label: 'Research Sub',
          type: 'codex-sdk',
          parent_session: 'deck_projA_brain',
          status: 'online',
          last_heartbeat_at: 123_456,
        };
      }
      return null;
    });

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.env = { DB: { queryOne } as never } as never;
      await next();
    });
    app.route('/api', tabSharingRoutes);

    const res = await app.request('/api/shares');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      shares: Array<{
        id: string;
        target: { kind: string };
        sessionState?: string;
        agentType?: string;
        parentSessionName?: string;
      }>;
    };
    expect(body.shares).toHaveLength(3);
    // Exactly 1 DB lookup per active share (zero extra queries)
    expect(queryOne).toHaveBeenCalledTimes(3);

    const byId = new Map(body.shares.map((s) => [s.id, s]));
    expect(byId.get('share-server')?.sessionState).toBeUndefined();
    expect(byId.get('share-server')?.agentType).toBeUndefined();
    expect(byId.get('share-server')?.parentSessionName).toBeUndefined();

    expect(byId.get('share-main')).toMatchObject({
      sessionState: 'running',
      agentType: 'claude-code',
    });
    expect(byId.get('share-main')?.parentSessionName).toBeUndefined();

    expect(byId.get('share-sub')).toMatchObject({
      agentType: 'codex-sdk',
      parentSessionName: 'deck_projA_brain',
    });
    expect(byId.get('share-sub')?.sessionState).toBeUndefined();
  });
});
