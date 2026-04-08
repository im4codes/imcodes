import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const createSubSessionMock = vi.fn();
const updateSubSessionMock = vi.fn();
const sendToDaemonMock = vi.fn();

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('userId', 'test-user');
    return next();
  },
  resolveServerRole: vi.fn().mockResolvedValue('owner'),
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
});
