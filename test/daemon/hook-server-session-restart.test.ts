import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { MEMORY_MCP_SESSION_RESTART_BATCH_HOOK_PATH, MEMORY_MCP_SESSION_RESTART_HOOK_PATH } from '../../shared/memory-mcp-contracts.js';

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const stopSessionNowMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../src/daemon/command-handler.js', () => ({ stopSessionNow: stopSessionNowMock }));
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

function postRestart(port: number, sender: string, body: Record<string, unknown>, path = MEMORY_MCP_SESSION_RESTART_HOOK_PATH) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
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

  it('defaults an omitted single-target reset flag to false for legacy callers', async () => {
    const brain = record('deck_project_brain');
    const worker = record('deck_project_worker');
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);

    const response = await postRestart(port, brain.name, { from: brain.name, to: worker.name });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(restartSession).toHaveBeenCalledWith(worker.name, { reset: false }));
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

  it('accepts a 20-target batch without consuming ordinary send quota', async () => {
    const brain = record('deck_project_brain');
    const workers = Array.from({ length: 20 }, (_, index) => record(`deck_project_worker_${index}`, 'project'));
    getSessionMock.mockImplementation((name: string) => [brain, ...workers].find((session) => session.name === name) ?? null);

    const response = await postRestart(port, brain.name, {
      from: brain.name,
      targets: workers.map((worker) => ({ target: worker.name, reset: true, idempotencyKey: `reset-${worker.name}` })),
    }, MEMORY_MCP_SESSION_RESTART_BATCH_HOOK_PATH);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, accepted: true, targets: workers.map((worker) => worker.name) });
    await vi.waitFor(() => expect(restartSession).toHaveBeenCalledTimes(20));
    expect(restartSession).toHaveBeenCalledWith(workers[0]!.name, { reset: true });
  });

  it('queues lifecycle work after the 30-operation burst and does not duplicate idempotent retries', async () => {
    const brain = record('deck_project_brain');
    const worker = record('deck_project_worker');
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);
    listSessionsMock.mockReturnValue([brain, worker]);

    for (let index = 0; index < 30; index += 1) {
      await expect(postRestart(port, brain.name, { from: brain.name, to: worker.name, reset: false, idempotencyKey: `burst-${index}` })).resolves.toMatchObject({ status: 202 });
    }
    const queued = await postRestart(port, brain.name, { from: brain.name, to: worker.name, reset: false, idempotencyKey: 'queued-once' });
    expect(queued).toMatchObject({ status: 202, body: { queued: true } });
    const duplicate = await postRestart(port, brain.name, { from: brain.name, to: worker.name, reset: false, idempotencyKey: 'queued-once' });
    expect(duplicate.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(restartSession).toHaveBeenCalledTimes(30);
  });

  it('lets urgent /stop through while lifecycle quota is exhausted', async () => {
    const brain = record('deck_project_brain');
    const worker = record('deck_project_worker');
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);
    for (let index = 0; index < 30; index += 1) {
      await postRestart(port, brain.name, { from: brain.name, to: worker.name, reset: false, idempotencyKey: `stop-burst-${index}` });
    }
    const response = await postRestart(port, brain.name, { from: brain.name, to: worker.name, message: '/stop' }, '/send');
    expect(response).toMatchObject({ status: 200, body: { ok: true, stopped: true } });
    expect(stopSessionNowMock).toHaveBeenCalledWith(worker.name);
  });

  it('returns a recoverable rate-limit response only after the lifecycle FIFO is full', async () => {
    const brain = record('deck_project_brain');
    const worker = record('deck_project_worker');
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);

    // Fill the 30-operation burst and the bounded 100-entry FIFO without
    // waiting for the one-minute window to expire.
    for (let index = 0; index < 130; index += 1) {
      await expect(postRestart(port, brain.name, {
        from: brain.name,
        to: worker.name,
        reset: false,
        idempotencyKey: `overflow-${index}`,
      })).resolves.toMatchObject({ status: 202 });
    }

    const overflow = await postRestart(port, brain.name, {
      from: brain.name,
      to: worker.name,
      reset: false,
      idempotencyKey: 'overflow-rejected',
    });
    expect(overflow.status).toBe(429);
    expect(overflow.body).toMatchObject({ ok: false, error: 'rate limit exceeded' });
    expect(typeof overflow.body.retryAfterMs).toBe('number');
  }, 15_000);

  it('rejects an over-capacity batch atomically without starting any target', async () => {
    const brain = record('deck_project_brain');
    const worker = record('deck_project_worker');
    const workerTwo = record('deck_project_worker_two');
    getSessionMock.mockImplementation((name: string) => [brain, worker, workerTwo].find((session) => session.name === name) ?? null);

    for (let index = 0; index < 129; index += 1) {
      await expect(postRestart(port, brain.name, {
        from: brain.name,
        to: worker.name,
        reset: false,
        idempotencyKey: `batch-fill-${index}`,
      })).resolves.toMatchObject({ status: 202 });
    }
    const response = await postRestart(port, brain.name, {
      from: brain.name,
      targets: [
        { target: worker.name, reset: false },
        { target: workerTwo.name, reset: false },
      ],
    }, MEMORY_MCP_SESSION_RESTART_BATCH_HOOK_PATH);

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ ok: false, error: 'rate limit exceeded' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restartSession).toHaveBeenCalledTimes(30);
    expect(restartSession).not.toHaveBeenCalledWith(workerTwo.name, expect.anything());
  }, 15_000);
});
