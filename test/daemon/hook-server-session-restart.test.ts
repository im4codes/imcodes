import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { MEMORY_MCP_SESSION_RESTART_HOOK_PATH } from '../../shared/memory-mcp-contracts.js';

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';

function record(name: string, projectName = 'project') {
  return {
    name, projectName, role: 'brain', agentType: 'codex-sdk', projectDir: `/tmp/${projectName}`,
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  };
}

function postRestart(port: number, sender: string, body: Record<string, unknown>) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: MEMORY_MCP_SESSION_RESTART_HOOK_PATH, method: 'POST', agent: false,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'x-imcodes-session': sender, Connection: 'close',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('hook-server exact session restart ingress', () => {
  let server: http.Server;
  let port: number;
  const restartSession = vi.fn(async () => true);

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    const started = await startHookServer(vi.fn(), { restartSession });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('acknowledges before scheduling reset of an exact same-project target', async () => {
    const brain = record('deck_project_brain');
    const worker = record('deck_project_worker');
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);

    const response = await postRestart(port, brain.name, { from: brain.name, to: worker.name, reset: true });

    expect(response).toEqual({
      status: 202,
      body: { ok: true, accepted: true, target: worker.name, reset: true },
    });
    await vi.waitFor(() => expect(restartSession).toHaveBeenCalledWith(worker.name, { reset: true }));
  });

  it('accepts restarting the caller itself without requiring a second session', async () => {
    const brain = record('deck_project_brain');
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : null);

    const response = await postRestart(port, brain.name, { from: brain.name, to: brain.name, reset: false });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(restartSession).toHaveBeenCalledWith(brain.name, { reset: false }));
  });

  it('rejects spoofed callers and cross-project targets before scheduling', async () => {
    const brain = record('deck_project_brain');
    const foreign = record('deck_other_brain', 'other');
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === foreign.name ? foreign : null);

    const spoofed = await postRestart(port, brain.name, { from: 'deck_spoofed_brain', to: brain.name, reset: false });
    const crossProject = await postRestart(port, brain.name, { from: brain.name, to: foreign.name, reset: false });

    expect(spoofed.status).toBe(400);
    expect(crossProject.status).toBe(404);
    expect(restartSession).not.toHaveBeenCalled();
  });
});
