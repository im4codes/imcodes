import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  REPO_CALLBACK_PREF_KEYS,
  repoCallbackServerPrefKey,
} from '../../shared/repo-callback.js';
import { NODE_ROLE, NODE_ROLE_REFUSAL } from '../../shared/remote-exec.js';

const getUserPrefMock = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
  resolveServerRole: vi.fn().mockResolvedValue('owner'),
}));

vi.mock('../src/db/queries.js', () => ({
  getFullServersByUserId: vi.fn().mockResolvedValue([]),
  updateServerHeartbeat: vi.fn(),
  updateServerName: vi.fn(),
  deleteServer: vi.fn(),
  getPlatformBotOwnerId: vi.fn(),
  upsertChannelBinding: vi.fn(),
  getServerById: vi.fn(),
  getServerSharedContextRuntimeConfig: vi.fn(),
  updateServerSharedContextRuntimeConfig: vi.fn(),
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  setUserPref: vi.fn(),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      sendToDaemon: vi.fn(),
    }),
  },
}));

describe('GET /api/server/:id/repo-callbacks/daemon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function makeApp(serverRow: Record<string, unknown> | null) {
    const { serverRoutes } = await import('../src/routes/server.js');
    const app = new Hono();
    app.route('/api/server', serverRoutes);
    const db = {
      queryOne: vi.fn().mockResolvedValue(serverRow),
    };
    return { app, db };
  }

  it('rejects missing bearer token with 401', async () => {
    const { app, db } = await makeApp(null);
    const res = await app.request('/api/server/srv-1/repo-callbacks/daemon', {
      method: 'GET',
    }, { DB: db } as never);
    expect(res.status).toBe(401);
  });

  it('rejects controlled nodes with 403', async () => {
    const { app, db } = await makeApp({
      id: 'srv-ctrl',
      user_id: 'user-1',
      team_id: null,
      node_role: NODE_ROLE.CONTROLLED,
      revoked_at: null,
      owner_status: 'active',
    });
    const res = await app.request('/api/server/srv-ctrl/repo-callbacks/daemon', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-ctrl-token' },
    }, { DB: db } as never);
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string; reason: string };
    expect(json.reason).toBe(NODE_ROLE_REFUSAL.CONTROLLED_NODE);
  });

  it('returns normalized global templates and server repo configs for authorized full daemon', async () => {
    getUserPrefMock.mockImplementation(async (_db: unknown, userId: string, key: string) => {
      expect(userId).toBe('user-1');
      if (key === REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES) {
        return JSON.stringify({
          version: 1,
          templates: [
            { id: 'tpl-g1', name: 'Global CI', scope: 'global', eventType: 'ci_failed', prompt: 'Check {{callbackId}}' },
          ],
        });
      }
      if (key === repoCallbackServerPrefKey('srv-1')) {
        return JSON.stringify({
          version: 1,
          repos: {
            '/work/app': {
              projectDir: '/work/app',
              enabled: true,
              intervalMs: 120_000,
              target: 'brain',
              events: {
                ci_failed: { enabled: true, templateScope: 'global', templateId: 'tpl-g1' },
                pr_new: { enabled: true, templateScope: 'default' },
                issue_new: { enabled: false, templateScope: 'default' },
              },
              templates: [
                { id: 'tpl-r1', name: 'Repo PR', scope: 'repo', eventType: 'pr_new', prompt: 'Review #{{number}}' },
              ],
              updatedAt: 1000,
            },
          },
        });
      }
      return null;
    });

    const { app, db } = await makeApp({
      id: 'srv-1',
      user_id: 'user-1',
      team_id: null,
      node_role: NODE_ROLE.FULL,
      revoked_at: null,
      owner_status: 'active',
    });

    const res = await app.request('/api/server/srv-1/repo-callbacks/daemon', {
      method: 'GET',
      headers: { Authorization: 'Bearer daemon-secret' },
    }, { DB: db } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      globalTemplates: Array<{ id: string }>;
      repos: Record<string, { enabled: boolean; templates: Array<{ id: string }> }>;
    };
    expect(body.globalTemplates).toHaveLength(1);
    expect(body.globalTemplates[0].id).toBe('tpl-g1');
    expect(body.repos['/work/app']?.enabled).toBe(true);
    expect(body.repos['/work/app']?.templates[0]?.id).toBe('tpl-r1');
  });

  it('safely handles malformed pref JSON by falling back to empty config', async () => {
    getUserPrefMock.mockResolvedValue('{bad json');
    const { app, db } = await makeApp({
      id: 'srv-1',
      user_id: 'user-1',
      team_id: null,
      node_role: NODE_ROLE.FULL,
      revoked_at: null,
      owner_status: 'active',
    });
    const res = await app.request('/api/server/srv-1/repo-callbacks/daemon', {
      method: 'GET',
      headers: { Authorization: 'Bearer daemon-secret' },
    }, { DB: db } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ globalTemplates: [], repos: {} });
  });
});
