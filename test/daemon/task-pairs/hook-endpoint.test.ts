import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { TASK_PAIR_ENGINE_HOOK_PATH, TASK_PAIR_LEGACY_TOOL_HOOK_PATH } from '../../../shared/task-pair.js';
import { SUPERVISION_MCP_TOOLS } from '../../../shared/supervision-mcp-tools.js';

const answerMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const pairsEngineMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  listSessions: vi.fn(() => []),
}));
vi.mock('../../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../../src/util/logger.js', () => ({ default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/daemon/task-pairs/legacy-tools.js', () => ({ answerLegacyToolInDaemon: answerMock }));
vi.mock('../../../src/daemon/task-pairs/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/daemon/task-pairs/engine.js')>()),
  isPairsEngineSession: pairsEngineMock,
}));

import { clearQueues, startHookServer } from '../../../src/daemon/hook-server.js';

function post(port: number, sender: string, body: Record<string, unknown>, path: string = TASK_PAIR_LEGACY_TOOL_HOOK_PATH) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-imcodes-session': sender, Connection: 'close' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('task-pair legacy tool hook endpoint', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    getSessionMock.mockImplementation((name: string) => (name === 'deck_sub_exec' ? { name, projectName: 'p', state: 'idle' } : undefined));
    const started = await startHookServer(vi.fn());
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers for the authenticated caller in the daemon', async () => {
    answerMock.mockResolvedValue({ handled: true, result: { status: 'ok', engine: 'pairs' } });
    const response = await post(port, 'deck_sub_exec', { from: 'deck_sub_exec', tool: SUPERVISION_MCP_TOOLS.INTENT, input: { intent: 'open_audit' } });
    expect(response).toEqual({ status: 200, body: { handled: true, result: { status: 'ok', engine: 'pairs' } } });
    expect(answerMock).toHaveBeenCalledWith(SUPERVISION_MCP_TOOLS.INTENT, 'deck_sub_exec', { intent: 'open_audit' });
  });

  it('refuses a spoofed or unknown caller', async () => {
    expect((await post(port, 'someone_else', { from: 'deck_sub_exec', tool: SUPERVISION_MCP_TOOLS.INTENT })).status).toBe(400);
    expect((await post(port, 'deck_sub_ghost', { from: 'deck_sub_ghost', tool: SUPERVISION_MCP_TOOLS.INTENT })).status).toBe(400);
    expect(answerMock).not.toHaveBeenCalled();
  });

  it('tells an MCP child whether its authenticated session is on the pairs engine', async () => {
    pairsEngineMock.mockReturnValueOnce(true);
    expect(await post(port, 'deck_sub_exec', { from: 'deck_sub_exec' }, TASK_PAIR_ENGINE_HOOK_PATH))
      .toEqual({ status: 200, body: { ok: true, pairs: true } });
    pairsEngineMock.mockReturnValueOnce(false);
    expect(await post(port, 'deck_sub_exec', { from: 'deck_sub_exec' }, TASK_PAIR_ENGINE_HOOK_PATH))
      .toEqual({ status: 200, body: { ok: true, pairs: false } });
    expect(pairsEngineMock).toHaveBeenCalledWith('deck_sub_exec');
    // Spoofed or unknown callers get no answer.
    expect((await post(port, 'someone_else', { from: 'deck_sub_exec' }, TASK_PAIR_ENGINE_HOOK_PATH)).status).toBe(400);
    expect((await post(port, 'deck_sub_ghost', { from: 'deck_sub_ghost' }, TASK_PAIR_ENGINE_HOOK_PATH)).status).toBe(400);
  });
});
