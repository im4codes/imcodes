/**
 * Regression: `/stop` sent as TEXT through the agent send pipeline
 * (`imcodes send <target> "/stop"` → hook /send) must take the priority
 * force-stop path (`stopSessionNow`), NOT the ordinary send queue.
 *
 * Observed live on 211 (deck_cd_w41): "/stop" was queued behind the running
 * turn and eventually delivered to the MODEL as text — the model replied
 * "/stop isn't available in this environment." while the turn kept going,
 * violating the transport command liveness mandate (CLAUDE.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const sendProcessSessionMessageForAutomationMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const stopSessionNowMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn() },
}));

vi.mock('../../src/daemon/command-handler.js', () => ({
  sendProcessSessionMessageForAutomation: sendProcessSessionMessageForAutomationMock,
  stopSessionNow: stopSessionNowMock,
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
    name: 'deck_alpha_brain',
    projectName: 'alpha',
    role: 'brain',
    agentType: 'claude-code',
    projectDir: '/work/alpha',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function postSend(port: number, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/send',
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

describe('hook-server /send with "/stop" text', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    stopSessionNowMock.mockReturnValue(true);
    clearQueues();
    const result = await startHookServer(vi.fn());
    server = result.server;
    port = result.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('routes exact "/stop" text to the priority force-stop, never the send queue', async () => {
    const brain = makeSession({ name: 'deck_alpha_brain', role: 'brain' });
    const worker = makeSession({ name: 'deck_alpha_w1', role: 'w1', label: 'Coder' });
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);
    listSessionsMock.mockReturnValue([brain, worker]);

    const res = await postSend(port, { from: 'deck_alpha_brain', to: 'deck_alpha_w1', message: '/stop' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stopped: true, target: 'deck_alpha_w1' });
    expect(stopSessionNowMock).toHaveBeenCalledWith('deck_alpha_w1');
    // The control command must NEVER be delivered as an ordinary message.
    expect(sendProcessSessionMessageForAutomationMock).not.toHaveBeenCalled();
  });

  it('routes surrounding-whitespace "/stop" to the force-stop as well', async () => {
    const brain = makeSession({ name: 'deck_alpha_brain', role: 'brain' });
    const worker = makeSession({ name: 'deck_alpha_w1', role: 'w1' });
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);
    listSessionsMock.mockReturnValue([brain, worker]);

    const res = await postSend(port, { from: 'deck_alpha_brain', to: 'deck_alpha_w1', message: '  /stop\n' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stopped: true, target: 'deck_alpha_w1' });
    expect(stopSessionNowMock).toHaveBeenCalledWith('deck_alpha_w1');
    expect(sendProcessSessionMessageForAutomationMock).not.toHaveBeenCalled();
  });

  it('reports not-stoppable without queueing when the priority stop declines', async () => {
    stopSessionNowMock.mockReturnValue(false);
    const brain = makeSession({ name: 'deck_alpha_brain', role: 'brain' });
    const worker = makeSession({ name: 'deck_alpha_w1', role: 'w1' });
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);
    listSessionsMock.mockReturnValue([brain, worker]);

    const res = await postSend(port, { from: 'deck_alpha_brain', to: 'deck_alpha_w1', message: '/stop' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, stopped: false, target: 'deck_alpha_w1' });
    expect(sendProcessSessionMessageForAutomationMock).not.toHaveBeenCalled();
  });

  it('keeps messages that merely CONTAIN "/stop" on the ordinary send path', async () => {
    const brain = makeSession({ name: 'deck_alpha_brain', role: 'brain' });
    const worker = makeSession({ name: 'deck_alpha_w1', role: 'w1' });
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);
    listSessionsMock.mockReturnValue([brain, worker]);

    const res = await postSend(port, { from: 'deck_alpha_brain', to: 'deck_alpha_w1', message: '请解释 /stop 命令的作用' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivered: true, target: 'deck_alpha_w1' });
    expect(stopSessionNowMock).not.toHaveBeenCalled();
    expect(sendProcessSessionMessageForAutomationMock).toHaveBeenCalledWith('deck_alpha_w1', '请解释 /stop 命令的作用');
  });
});
