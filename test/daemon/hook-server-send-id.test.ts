import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import { isSendDispatchId, isSendMessageId } from '../../shared/send-message-id.js';

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const sendProcessSessionMessageForAutomationMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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

function postList(port: number, from: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ from });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/list',
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

describe('hook-server /send ids', () => {
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

  it('returns dispatchId/messageId while preserving single-target compatibility fields', async () => {
    const brain = makeSession({ name: 'deck_alpha_brain', role: 'brain' });
    const worker = makeSession({ name: 'deck_alpha_w1', role: 'w1', label: 'Coder' });
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : name === worker.name ? worker : null);
    listSessionsMock.mockReturnValue([brain, worker]);

    const res = await postSend(port, { from: 'deck_alpha_brain', to: 'Coder', message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, delivered: true, target: 'deck_alpha_w1' });
    expect(isSendDispatchId(res.body.dispatchId)).toBe(true);
    expect(isSendMessageId(res.body.messageId)).toBe(true);
    expect(sendProcessSessionMessageForAutomationMock).toHaveBeenCalledWith('deck_alpha_w1', 'hello');
  });

  it('does not list raw frontend-hidden project workers as send targets', async () => {
    const brain = makeSession({ name: 'deck_alpha_brain', role: 'brain' });
    const hiddenWorker = makeSession({ name: 'deck_alpha_w1', role: 'w1' });
    const visibleSub = makeSession({
      name: 'deck_sub_cc1',
      role: 'w1',
      label: 'CC1',
      parentSession: 'deck_alpha_brain',
      userCreated: true,
    });
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : null);
    listSessionsMock.mockReturnValue([brain, hiddenWorker, visibleSub]);

    const res = await postList(port, brain.name);

    expect(res.status).toBe(200);
    expect((res.body.sessions as Array<{ name: string }>).map((session) => session.name)).toEqual(['deck_sub_cc1']);
  });

  it('returns per-target message ids for broadcast while preserving delivered array', async () => {
    const brain = makeSession({ name: 'deck_alpha_brain', role: 'brain' });
    const w1 = makeSession({ name: 'deck_alpha_w1', role: 'w1', label: 'Coder1' });
    const w2 = makeSession({ name: 'deck_alpha_w2', role: 'w2', label: 'Coder2' });
    getSessionMock.mockImplementation((name: string) => name === brain.name ? brain : null);
    listSessionsMock.mockReturnValue([brain, w1, w2]);

    const res = await postSend(port, { from: 'deck_alpha_brain', to: '*', message: 'hello all' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.delivered).toEqual(['deck_alpha_w1', 'deck_alpha_w2']);
    expect(isSendDispatchId(res.body.dispatchId)).toBe(true);
    expect(res.body.messages).toEqual([
      { target: 'deck_alpha_w1', messageId: expect.any(String), status: 'delivered' },
      { target: 'deck_alpha_w2', messageId: expect.any(String), status: 'delivered' },
    ]);
    for (const item of res.body.messages as Array<{ messageId: string }>) {
      expect(isSendMessageId(item.messageId)).toBe(true);
    }
  });
});
