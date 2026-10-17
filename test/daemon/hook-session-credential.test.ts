import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import {
  HOOK_SESSION_CREDENTIAL_ENV,
  HOOK_SESSION_CREDENTIAL_ERROR,
  HOOK_SESSION_CREDENTIAL_HEADER,
  hookCredentialHeaders,
} from '../../shared/hook-session-credential.js';
import { MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH } from '../../shared/memory-mcp-contracts.js';

const getSessionMock = vi.hoisted(() => vi.fn());
const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  listSessions: vi.fn(() => sessions.list),
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn() } }));
vi.mock('../../src/daemon/watcher-controls.js', () => ({ refreshSessionWatcher: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { clearQueues, startHookServer } from '../../src/daemon/hook-server.js';
import { buildWorkerSessionPersistBody } from '../../src/daemon/session-bootstrap.js';
import { hookCredentialEnv, mintHookCredential } from '../../src/daemon/hook-session-credential.js';

function record(name: string, extra: Record<string, unknown> = {}) {
  return {
    name, projectName: 'alpha', role: 'w1', agentType: 'claude-code-sdk', projectDir: '/tmp/alpha',
    state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, ...extra,
  };
}

function post(port: number, path: string, body: Record<string, unknown>, headers: Record<string, string>) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('hook session credential', () => {
  const owner = record('deck_owner_brain', { hookCredential: 'cred-owner' });
  const attacker = record('deck_attacker_w1', { hookCredential: 'cred-attacker' });
  const legacy = record('deck_legacy_w1');
  const listSessionModels = vi.fn(async (sessionName: string) => ({
    ok: true as const, sessionName, agentType: 'claude-code-sdk', currentModel: 'sonnet', models: ['sonnet'], acceptsAnyModel: false,
  }));
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearQueues();
    sessions.list = [owner, attacker, legacy];
    getSessionMock.mockImplementation((name: string) => [owner, attacker, legacy].find((s) => s.name === name) ?? null);
    const started = await startHookServer(vi.fn(), { listSessionModels, switchSessionModel: vi.fn() });
    server = started.server;
    port = started.port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const listModels = (sender: string, headers: Record<string, string> = {}) => post(
    port, MEMORY_MCP_SESSION_MODEL_LIST_HOOK_PATH, { from: sender, to: owner.name }, { 'x-imcodes-session': sender, ...headers },
  );

  it('accepts the session that presents its own credential', async () => {
    const response = await listModels(owner.name, { [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-owner' });
    expect(response.status).toBe(200);
  });

  it('refuses a header claim of another session without or with the wrong credential (counterexample: passed on the base)', async () => {
    const none = await listModels(owner.name);
    expect(none).toEqual({ status: 403, body: { ok: false, error: HOOK_SESSION_CREDENTIAL_ERROR } });
    const own = await listModels(owner.name, { [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-attacker' });
    expect(own.status).toBe(403);
    const empty = await listModels(owner.name, { [HOOK_SESSION_CREDENTIAL_HEADER]: '' });
    expect(empty.status).toBe(403);
    expect(listSessionModels).not.toHaveBeenCalled();
  });

  it('refuses a body `from` claim on /send and /list without the credential', async () => {
    const send = await post(port, '/send', { from: owner.name, to: legacy.name, message: 'hi' }, {});
    expect(send.status).toBe(403);
    expect(send.body.error).toBe(HOOK_SESSION_CREDENTIAL_ERROR);
    const sendWrong = await post(port, '/send', { from: owner.name, to: legacy.name, message: 'hi' }, { [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-attacker' });
    expect(sendWrong.status).toBe(403);
    const list = await post(port, '/list', { from: owner.name }, {});
    expect(list.status).toBe(403);
    const listOk = await post(port, '/list', { from: owner.name }, { [HOOK_SESSION_CREDENTIAL_HEADER]: 'cred-owner' });
    expect(listOk.status).toBe(200);
  });

  it('leaves sessions without a stored credential (legacy / transport) on the name-only behaviour', async () => {
    const response = await listModels(legacy.name);
    expect(response.status).toBe(200);
  });

  it('does not tie external-CLI senders or unknown names to any credential', async () => {
    const list = await post(port, '/list', { from: '__imcodes_external_cli__' }, {});
    expect(list.status).toBe(200);
  });

  it('client headers come from the process environment only', () => {
    expect(hookCredentialHeaders({})).toEqual({});
    expect(hookCredentialHeaders({ [HOOK_SESSION_CREDENTIAL_ENV]: 'abc' })).toEqual({ [HOOK_SESSION_CREDENTIAL_HEADER]: 'abc' });
  });

  it('mints a distinct, unguessable credential per launch and exports it to the launched process', () => {
    const a = mintHookCredential();
    const b = mintHookCredential();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(hookCredentialEnv(a)).toEqual({ [HOOK_SESSION_CREDENTIAL_ENV]: a });
    expect(hookCredentialEnv(undefined)).toEqual({});
  });

  it('never puts the credential in the record the daemon sends to the server', () => {
    expect(JSON.stringify(buildWorkerSessionPersistBody(owner as never))).not.toContain('cred-owner');
  });
});
