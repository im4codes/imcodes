import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { MEMORY_MCP_SESSION_CLOSE_HOOK_PATH } from '../../shared/memory-mcp-contracts.js';
import type { SessionCloseRequest, SessionCloseResult } from '../../shared/session-close.js';

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(),
  upsertSession: vi.fn(),
  listSessions: vi.fn(() => []),
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';

function post(port: number, sender: string | undefined, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: MEMORY_MCP_SESSION_CLOSE_HOOK_PATH, method: 'POST', agent: false,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close',
        ...(sender ? { 'x-imcodes-session': sender } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('hook-server session close ingress', () => {
  let server: http.Server;
  let port: number;
  const closeSession = vi.fn<(caller: string, request: SessionCloseRequest) => Promise<SessionCloseResult>>();

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    closeSession.mockResolvedValue({ status: 'closed', target: 'deck_sub_a', authority: 'brain', serverNotified: true, forced: false });
    const started = await startHookServer(vi.fn(), { closeSession });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('takes the caller from the authenticated header and forwards only the exact target and the two Brain flags', async () => {
    const response = await post(port, 'deck_proj_brain', {
      from: 'deck_proj_brain', target: ' deck_sub_a ', force: true, confirmUserCreated: true, to: 'deck_other', extra: 'x',
    });
    expect(response).toEqual({
      status: 200,
      body: { ok: true, status: 'closed', target: 'deck_sub_a', authority: 'brain', serverNotified: true, forced: false },
    });
    expect(closeSession).toHaveBeenCalledWith('deck_proj_brain', { target: 'deck_sub_a', force: true, confirmUserCreated: true });
  });

  it('omits the flags unless they are literally true', async () => {
    await post(port, 'deck_proj_brain', { from: 'deck_proj_brain', target: 'deck_sub_a', force: 'true', confirmUserCreated: 1 });
    expect(closeSession).toHaveBeenCalledWith('deck_proj_brain', { target: 'deck_sub_a' });
  });

  it('rejects a spoofed or missing caller identity before anything is decided', async () => {
    const spoofed = await post(port, 'deck_sub_peer', { from: 'deck_proj_brain', target: 'deck_sub_a', force: true });
    const anonymous = await post(port, undefined, { from: 'deck_proj_brain', target: 'deck_sub_a' });
    expect(spoofed.status).toBe(400);
    expect(anonymous.status).toBe(400);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('rejects a missing target and a non-JSON request', async () => {
    expect((await post(port, 'deck_proj_brain', { from: 'deck_proj_brain' })).status).toBe(400);
    expect((await post(port, 'deck_proj_brain', { from: 'deck_proj_brain', target: '   ' })).status).toBe(400);
    expect((await post(port, 'deck_proj_brain', 'not json', {})).status).toBe(400);
    expect((await post(port, 'deck_proj_brain', '{}', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('answers a refusal as a structured result, not as a transport error', async () => {
    closeSession.mockResolvedValueOnce({ status: 'refused', target: 'deck_sub_a', reason: 'open_pair', detail: 'it is executor of open pair(s) tsk_1' });
    const response = await post(port, 'deck_proj_brain', { from: 'deck_proj_brain', target: 'deck_sub_a' });
    expect(response).toEqual({
      status: 200,
      body: { ok: true, status: 'refused', target: 'deck_sub_a', reason: 'open_pair', detail: 'it is executor of open pair(s) tsk_1' },
    });
  });

  it('turns a close that throws into a 400, never a crash', async () => {
    closeSession.mockRejectedValueOnce(new Error('boom'));
    const response = await post(port, 'deck_proj_brain', { from: 'deck_proj_brain', target: 'deck_sub_a' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ ok: false });
  });
});
