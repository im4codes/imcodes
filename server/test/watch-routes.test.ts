import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import { IMCODES_POD_HEADER } from '../../shared/http-header-names.js';

const mockResolveServerRole = vi.fn<() => Promise<string>>().mockResolvedValue('owner');
const mockGetServersByUserId = vi.fn();
const mockGetDbSessionsByServer = vi.fn();
const mockGetSubSessionsByServer = vi.fn();
const mockGetUserPref = vi.fn();
const mockRequestTimelineHistory = vi.fn();
const mockGetRecentText = vi.fn();
const mockGetActiveMainSessions = vi.fn();
const mockHasReceivedActiveMainSessionSnapshot = vi.fn();
const mockSendToDaemon = vi.fn();
const mockGetPodIdentity = vi.fn(() => 'pod-a');

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'member');
    await next();
  },
  resolveServerRole: (...args: unknown[]) => mockResolveServerRole(...args as []),
}));

vi.mock('../src/db/queries.js', () => ({
  getServersByUserId: (...args: unknown[]) => mockGetServersByUserId(...args),
  getDbSessionsByServer: (...args: unknown[]) => mockGetDbSessionsByServer(...args),
  getSubSessionsByServer: (...args: unknown[]) => mockGetSubSessionsByServer(...args),
  getUserPref: (...args: unknown[]) => mockGetUserPref(...args),
  getServerById: vi.fn(async () => ({ id: 'srv-1' })),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    get: () => ({
      requestTimelineHistory: (...args: unknown[]) => mockRequestTimelineHistory(...args),
      getRecentText: (...args: unknown[]) => mockGetRecentText(...args),
      getActiveMainSessions: (...args: unknown[]) => mockGetActiveMainSessions(...args),
      hasReceivedActiveMainSessionSnapshot: (...args: unknown[]) => mockHasReceivedActiveMainSessionSnapshot(...args),
      sendToDaemon: (...args: unknown[]) => mockSendToDaemon(...args),
    }),
  },
}));

vi.mock('../src/util/pod-identity.js', () => ({
  getPodIdentity: () => mockGetPodIdentity(),
}));

function makeEnv(): Env {
  return {
    DB: {} as never,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'test',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

async function buildTestApp() {
  const { watchRoutes } = await import('../src/routes/watch.js');
  const { sessionMgmtRoutes } = await import('../src/routes/session-mgmt.js');

  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, makeEnv());
    await next();
  });
  app.route('/api', watchRoutes);
  app.route('/api/server', sessionMgmtRoutes);
  return app;
}

describe('Watch routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPodIdentity.mockReturnValue('pod-a');
    mockResolveServerRole.mockResolvedValue('owner');
    mockGetServersByUserId.mockResolvedValue([]);
    mockGetDbSessionsByServer.mockResolvedValue([]);
    mockGetSubSessionsByServer.mockResolvedValue([]);
    mockGetUserPref.mockResolvedValue(null);
    mockGetRecentText.mockReturnValue([]);
    mockGetActiveMainSessions.mockReturnValue([]);
    mockHasReceivedActiveMainSessionSnapshot.mockReturnValue(false);
    mockRequestTimelineHistory.mockResolvedValue({ epoch: 7, events: [] });
  });

  it('GET /api/watch/servers returns visible servers with baseUrl', async () => {
    mockGetServersByUserId.mockResolvedValue([
      { id: 'srv-1', name: 'Alpha' },
      { id: 'srv-2', name: 'Beta' },
    ]);

    const app = await buildTestApp();
    const res = await app.request('/api/watch/servers');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      servers: [
        { id: 'srv-1', name: 'Alpha', baseUrl: 'https://app.im.codes' },
        { id: 'srv-2', name: 'Beta', baseUrl: 'https://app.im.codes' },
      ],
    });
  });

  it('GET /api/watch/sessions returns main and sub-session rows with recentText', async () => {
    mockGetDbSessionsByServer.mockResolvedValue([
      {
        name: 'deck_proj_brain',
        project_name: 'proj',
        label: 'Main',
        state: 'running',
        agent_type: 'claude-code',
      },
    ]);
    mockGetSubSessionsByServer.mockResolvedValue([
      {
        id: 'abc123',
        type: 'codex',
        label: 'Worker 1',
        parent_session: 'deck_proj_brain',
        closed_at: null,
      },
    ]);
    mockGetRecentText.mockImplementation((sessionName: string) => (
      sessionName === 'deck_proj_brain'
        ? [{ eventId: 'e1', type: 'assistant.text', text: 'latest assistant text', ts: 100 }]
        : [{ eventId: 'e2', type: 'user.message', text: 'worker text', ts: 200 }]
    ));

    const app = await buildTestApp();
    const res = await app.request('/api/watch/sessions?serverId=srv-1');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      serverId: 'srv-1',
      sessions: [
        {
          serverId: 'srv-1',
          sessionName: 'deck_proj_brain',
          title: 'Main',
          state: 'working',
          agentBadge: 'cc',
          isSubSession: false,
          parentTitle: undefined,
          parentSessionName: undefined,
          isPinned: false,
          previewText: 'latest assistant text',
          previewUpdatedAt: 100,
          recentText: [{ eventId: 'e1', type: 'assistant.text', text: 'latest assistant text', ts: 100 }],
        },
        {
          serverId: 'srv-1',
          sessionName: 'deck_sub_abc123',
          title: 'Worker 1',
          state: 'working',
          agentBadge: 'cx',
          isSubSession: true,
          parentTitle: 'Main',
          parentSessionName: 'deck_proj_brain',
          isPinned: false,
          previewText: 'worker text',
          previewUpdatedAt: 200,
          recentText: [{ eventId: 'e2', type: 'user.message', text: 'worker text', ts: 200 }],
        },
      ],
    });
  });

  it('GET /api/watch/sessions prefers live active sessions, prunes stale DB rows, and orders pinned tabs first', async () => {
    mockHasReceivedActiveMainSessionSnapshot.mockReturnValue(true);
    mockGetActiveMainSessions.mockReturnValue([
      { name: 'deck_proj_two', project: 'proj-two', state: 'idle', agentType: 'codex', label: 'Two' },
      { name: 'deck_proj_one', project: 'proj-one', state: 'running', agentType: 'claude-code', label: 'One' },
    ]);
    mockGetDbSessionsByServer.mockResolvedValue([
      { name: 'deck_proj_old', project_name: 'old', label: 'Old', state: 'idle', agent_type: 'codex' },
    ]);
    mockGetSubSessionsByServer.mockResolvedValue([
      { id: 'sub-1', type: 'codex', label: 'Worker 1', parent_session: 'deck_proj_one', closed_at: null },
      { id: 'sub-old', type: 'codex', label: 'Old Worker', parent_session: 'deck_proj_old', closed_at: null },
    ]);
    mockGetUserPref.mockImplementation(async (_db: unknown, _userId: string, key: string) => {
      if (key === 'tab_order') return JSON.stringify({ v: ['deck_proj_one', 'deck_proj_two'], t: 1 });
      if (key === 'tab_pinned') return JSON.stringify({ v: ['deck_proj_two'], t: 1 });
      return null;
    });

    const app = await buildTestApp();
    const res = await app.request('/api/watch/sessions?serverId=srv-1');

    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: Array<{ sessionName: string; isPinned?: boolean; parentSessionName?: string | null }> };
    expect(body.sessions.map((row) => row.sessionName)).toEqual([
      'deck_proj_two',
      'deck_proj_one',
      'deck_sub_sub-1',
    ]);
    expect(body.sessions[0]?.isPinned).toBe(true);
    expect(body.sessions[1]?.isPinned).toBe(false);
    expect(body.sessions[2]?.parentSessionName).toBe('deck_proj_one');
  });

  it('GET /api/server/:id/timeline/history preserves event identity and pagination metadata', async () => {
    const events = [
      { eventId: 'e-old', sessionId: 'deck_proj_brain', ts: 100, type: 'user.message', payload: { text: 'older' } },
      { eventId: 'e-new', sessionId: 'deck_proj_brain', ts: 200, type: 'assistant.text', payload: { text: 'newer' } },
    ];
    mockRequestTimelineHistory.mockResolvedValue({ epoch: 9, events });

    const app = await buildTestApp();
    const res = await app.request('/api/server/srv-1/timeline/history?sessionName=deck_proj_brain&limit=2');

    expect(res.status).toBe(200);
    expect(res.headers.get(IMCODES_POD_HEADER)).toBe('pod-a');
    await expect(res.json()).resolves.toEqual({
      sessionName: 'deck_proj_brain',
      epoch: 9,
      events,
      hasMore: true,
      nextCursor: 100,
    });
    expect(mockRequestTimelineHistory).toHaveBeenCalledWith({ sessionName: 'deck_proj_brain', limit: 2 });
  });

  it('GET /api/server/:id/timeline/history forwards beforeTs and reports no more history when the page is short', async () => {
    const events = [
      { eventId: 'e-1', sessionId: 'deck_proj_brain', ts: 90, type: 'assistant.text', payload: { text: 'only one' } },
    ];
    mockRequestTimelineHistory.mockResolvedValue({ epoch: 10, events });

    const app = await buildTestApp();
    const res = await app.request('/api/server/srv-1/timeline/history?sessionName=deck_proj_brain&limit=50&beforeTs=200');

    expect(res.status).toBe(200);
    expect(res.headers.get(IMCODES_POD_HEADER)).toBe('pod-a');
    await expect(res.json()).resolves.toEqual({
      sessionName: 'deck_proj_brain',
      epoch: 10,
      events,
      hasMore: false,
      nextCursor: null,
    });
    expect(mockRequestTimelineHistory).toHaveBeenCalledWith({
      sessionName: 'deck_proj_brain',
      limit: 50,
      beforeTs: 200,
    });
  });

  it('GET /api/server/:id/timeline/history returns 503 when daemon is offline', async () => {
    mockRequestTimelineHistory.mockRejectedValue(new Error('daemon_offline'));
    const app = await buildTestApp();
    const res = await app.request('/api/server/srv-1/timeline/history?sessionName=deck_proj_brain');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'daemon_offline' });
  });

  it('watch routes return 403 when the user has no access to the server', async () => {
    mockResolveServerRole.mockResolvedValue('none');
    const app = await buildTestApp();

    const sessionsRes = await app.request('/api/watch/sessions?serverId=srv-1');
    const historyRes = await app.request('/api/server/srv-1/timeline/history?sessionName=deck_proj_brain');
    const sendRes = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_proj_brain', text: 'hello' }),
    });

    expect(sessionsRes.status).toBe(403);
    await expect(sessionsRes.json()).resolves.toEqual({ error: 'forbidden' });

    expect(historyRes.status).toBe(403);
    await expect(historyRes.json()).resolves.toEqual({ error: 'forbidden' });

    expect(sendRes.status).toBe(403);
    await expect(sendRes.json()).resolves.toEqual({
      error: 'forbidden',
      reason: 'not_authorized_for_server',
    });
  });

  it('GET /api/server/:id/timeline/history returns 504 when relay times out', async () => {
    mockRequestTimelineHistory.mockRejectedValue(new Error('timeout'));
    const app = await buildTestApp();
    const res = await app.request('/api/server/srv-1/timeline/history?sessionName=deck_proj_brain');
    expect(res.status).toBe(504);
    await expect(res.json()).resolves.toEqual({ error: 'timeline_timeout' });
  });

  it('POST /api/server/:id/session/send keeps commandId passthrough', async () => {
    const app = await buildTestApp();
    const res = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_proj_brain', text: 'hello', commandId: 'cmd-1' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(IMCODES_POD_HEADER)).toBe('pod-a');
    expect(mockSendToDaemon).toHaveBeenCalledWith(JSON.stringify({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'hello',
      commandId: 'cmd-1',
    }));
  });

  it('live send/history routes expose the same pod identity header', async () => {
    mockRequestTimelineHistory.mockResolvedValue({ epoch: 9, events: [] });
    const app = await buildTestApp();
    const historyRes = await app.request('/api/server/srv-1/timeline/history?sessionName=deck_proj_brain');
    const sendRes = await app.request('/api/server/srv-1/session/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionName: 'deck_proj_brain', text: 'smoke', commandId: 'cmd-2' }),
    });

    expect(historyRes.status).toBe(200);
    expect(sendRes.status).toBe(200);
    expect(historyRes.headers.get(IMCODES_POD_HEADER)).toBe('pod-a');
    expect(sendRes.headers.get(IMCODES_POD_HEADER)).toBe('pod-a');
  });
});
