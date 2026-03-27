/**
 * Tests for hook-server session validation (Layer 2).
 * Verifies that hooks from non-managed or non-CC sessions are rejected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

// ── Mocks ──────────────────────────────────────────────────────────────────

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const timelineEmitMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitMock, on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { startHookServer } from '../../src/daemon/hook-server.js';

function postNotify(port: number, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/notify', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Hook server — session validation', () => {
  let server: http.Server;
  let port: number;
  const hookCallback = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    const result = await startHookServer(hookCallback);
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    server.close();
  });

  it('rejects hook when session does not exist in store', async () => {
    getSessionMock.mockReturnValue(null);

    const res = await postNotify(port, { event: 'tool_start', session: 'deck_unknown', tool: 'Read' });

    expect(res.status).toBe(200);
    expect(res.body).toBe('ignored');
    expect(timelineEmitMock).not.toHaveBeenCalledWith('deck_unknown', 'tool.call', expect.anything(), expect.anything());
    expect(hookCallback).not.toHaveBeenCalled();
  });

  it('rejects hook when session is gemini (not claude-code)', async () => {
    getSessionMock.mockReturnValue({ name: 'deck_proj_brain', agentType: 'gemini', state: 'running' });

    const res = await postNotify(port, { event: 'tool_start', session: 'deck_proj_brain', tool: 'Bash' });

    expect(res.status).toBe(200);
    expect(res.body).toBe('ignored');
    expect(timelineEmitMock).not.toHaveBeenCalledWith('deck_proj_brain', 'tool.call', expect.anything(), expect.anything());
  });

  it('rejects hook when session is shell type', async () => {
    getSessionMock.mockReturnValue({ name: 'deck_sub_shell1', agentType: 'shell', state: 'running' });

    const res = await postNotify(port, { event: 'idle', session: 'deck_sub_shell1' });

    expect(res.status).toBe(200);
    expect(res.body).toBe('ignored');
    expect(hookCallback).not.toHaveBeenCalled();
  });

  it('accepts hook for valid claude-code session', async () => {
    getSessionMock.mockReturnValue({ name: 'deck_cd_brain', agentType: 'claude-code', state: 'running' });

    const res = await postNotify(port, { event: 'tool_start', session: 'deck_cd_brain', tool: 'Read' });

    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(timelineEmitMock).toHaveBeenCalledWith('deck_cd_brain', 'tool.call', expect.objectContaining({ tool: 'Read' }), expect.anything());
    expect(hookCallback).toHaveBeenCalledWith(expect.objectContaining({ event: 'tool_start', session: 'deck_cd_brain' }));
  });

  it('accepts idle hook for valid claude-code session', async () => {
    getSessionMock.mockReturnValue({ name: 'deck_cd_w1', agentType: 'claude-code', state: 'running' });

    const res = await postNotify(port, { event: 'idle', session: 'deck_cd_w1' });

    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(hookCallback).toHaveBeenCalledWith(expect.objectContaining({ event: 'idle' }));
  });

  it('returns 400 when event or session is missing', async () => {
    const res1 = await postNotify(port, { event: 'idle' });
    expect(res1.status).toBe(400);

    const res2 = await postNotify(port, { session: 'deck_cd_brain' });
    expect(res2.status).toBe(400);
  });
});
