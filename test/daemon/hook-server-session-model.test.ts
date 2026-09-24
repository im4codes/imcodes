import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import {
  MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH,
  MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH,
} from '../../shared/memory-mcp-contracts.js';

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  listSessions: vi.fn(() => []),
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';

function record(name: string, projectName: string) {
  return {
    name, projectName, role: 'w1', agentType: 'claude-code-sdk', projectDir: `/tmp/${projectName}`,
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1,
  };
}

function post(port: number, path: string, sender: string, body: Record<string, unknown>) {
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

describe('hook-server session model control', () => {
  let server: http.Server;
  let port: number;
  const switchSessionModel = vi.fn(async (sessionName: string, model: string) => ({
    ok: true as const, sessionName, agentType: 'claude-code-sdk', model, previousModel: 'sonnet',
  }));
  const listSessionModels = vi.fn(async (sessionName: string) => ({
    ok: true as const, sessionName, agentType: 'claude-code-sdk', currentModel: 'sonnet', models: ['sonnet', 'haiku'], acceptsAnyModel: false,
  }));
  const caller = record('deck_brain_a', 'alpha');
  // A different project: by request there is no ownership or project check.
  const target = record('deck_sub_cc1', 'beta');

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    getSessionMock.mockImplementation((name: string) => name === caller.name ? caller : name === target.name ? target : null);
    const started = await startHookServer(vi.fn(), { switchSessionModel, listSessionModels });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('switches any session by exact name, across projects', async () => {
    const response = await post(port, MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH, caller.name, { from: caller.name, to: target.name, model: 'haiku' });
    expect(response).toEqual({
      status: 200,
      body: { status: 'ok', sessionName: target.name, agentType: 'claude-code-sdk', model: 'haiku', previousModel: 'sonnet' },
    });
    expect(switchSessionModel).toHaveBeenCalledWith(target.name, 'haiku');
  });

  it('lists a session\'s models', async () => {
    const response = await post(port, MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH, caller.name, { from: caller.name, to: target.name });
    expect(response.body).toMatchObject({ status: 'ok', currentModel: 'sonnet', models: ['sonnet', 'haiku'] });
  });

  it('passes a refusal through as a structured result the agent can act on', async () => {
    switchSessionModel.mockResolvedValueOnce({
      ok: false, sessionName: target.name, code: 'unknown_model', error: 'Unknown Claude model: gpt-6-sol', availableModels: ['sonnet'],
    } as never);
    const response = await post(port, MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH, caller.name, { from: caller.name, to: target.name, model: 'gpt-6-sol' });
    expect(response).toEqual({
      status: 200,
      body: {
        status: 'error', reason: 'unknown_model', sessionName: target.name, code: 'unknown_model',
        error: 'Unknown Claude model: gpt-6-sol', availableModels: ['sonnet'],
      },
    });
  });

  it('still requires an authenticated caller session', async () => {
    const spoofed = await post(port, MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH, 'someone_else', { from: caller.name, to: target.name, model: 'haiku' });
    expect(spoofed.status).toBe(400);
    const missingModel = await post(port, MEMORY_MCP_SESSION_MODEL_SET_HOOK_PATH, caller.name, { from: caller.name, to: target.name });
    expect(missingModel.status).toBe(400);
    expect(switchSessionModel).not.toHaveBeenCalled();
  });
});
