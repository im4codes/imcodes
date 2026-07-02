/**
 * Regression: `imcodes status` read sessions.json directly, whose `state` is a
 * multi-writer read-modify-write field — a slow spread-writer can resurrect a
 * stale 'running' minutes after the transport runtime settled idle (observed
 * live on 211: deck_cd_w41 authoritative-idle in the timeline at 13:35:33,
 * record stuck 'running' with fresh updatedAt for minutes).
 *
 * The hook `/sessions/live` endpoint reports the RUNTIME state for sessions
 * with a live transport runtime (authoritative) and self-heals the drifted
 * record so every record reader converges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const getTransportRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: getTransportRuntimeMock,
}));

vi.mock('../../src/daemon/watcher-controls.js', () => ({
  refreshSessionWatcher: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';

function makeSession(overrides: Record<string, unknown>) {
  return {
    name: 'deck_alpha_w1',
    projectName: 'alpha',
    role: 'w1',
    agentType: 'claude-code-sdk',
    projectDir: '/work/alpha',
    state: 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function postJson(port: number, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)), Connection: 'close' },
    }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(response) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('hook-server /sessions/live', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    const result = await startHookServer(vi.fn());
    server = result.server;
    port = result.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports the live runtime state over a stale record and repairs the record', async () => {
    // Record stuck 'running' (stale spread-writer) while the runtime is idle.
    const stale = makeSession({ name: 'deck_alpha_w1', state: 'running' });
    listSessionsMock.mockReturnValue([stale]);
    getSessionMock.mockImplementation((name: string) => (name === stale.name ? stale : null));
    getTransportRuntimeMock.mockImplementation((name: string) =>
      name === stale.name ? { getStatus: () => 'idle', pendingCount: 0 } : undefined);

    const res = await postJson(port, '/sessions/live', {});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessions).toEqual([
      { name: 'deck_alpha_w1', state: 'idle', live: true, pendingCount: 0 },
    ]);
    // Drift self-heal: the stale record is corrected from the runtime truth.
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_alpha_w1',
      state: 'idle',
    }));
  });

  it('maps in-progress runtime statuses to running and does not rewrite matching records', async () => {
    const record = makeSession({ name: 'deck_alpha_w2', state: 'running' });
    listSessionsMock.mockReturnValue([record]);
    getSessionMock.mockImplementation((name: string) => (name === record.name ? record : null));
    getTransportRuntimeMock.mockImplementation((name: string) =>
      name === record.name ? { getStatus: () => 'thinking', pendingCount: 2 } : undefined);

    const res = await postJson(port, '/sessions/live', {});

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      { name: 'deck_alpha_w2', state: 'running', live: true, pendingCount: 2 },
    ]);
    expect(upsertSessionMock).not.toHaveBeenCalled();
  });

  it('passes through record state for sessions without a live runtime and never repairs stopped records', async () => {
    const processSession = makeSession({ name: 'deck_alpha_shell', agentType: 'shell', state: 'idle' });
    const stopped = makeSession({ name: 'deck_alpha_w3', state: 'stopped' });
    listSessionsMock.mockReturnValue([processSession, stopped]);
    getSessionMock.mockImplementation((name: string) =>
      name === processSession.name ? processSession : name === stopped.name ? stopped : null);
    getTransportRuntimeMock.mockImplementation((name: string) =>
      name === stopped.name ? { getStatus: () => 'idle', pendingCount: 0 } : undefined);

    const res = await postJson(port, '/sessions/live', {});

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      { name: 'deck_alpha_shell', state: 'idle', live: false },
      { name: 'deck_alpha_w3', state: 'idle', live: true, pendingCount: 0 },
    ]);
    // A 'stopped' record is lifecycle state owned by stop/restore paths — the
    // live endpoint must not resurrect it.
    expect(upsertSessionMock).not.toHaveBeenCalled();
  });
});
