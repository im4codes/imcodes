/**
 * Tests for hook-server session validation (Layer 2).
 * Verifies that hooks from non-managed or non-CC sessions are rejected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

// ── Mocks ──────────────────────────────────────────────────────────────────

const getSessionMock = vi.hoisted(() => vi.fn());
const upsertSessionMock = vi.hoisted(() => vi.fn());
const listSessionsMock = vi.hoisted(() => vi.fn(() => []));
const timelineEmitMock = vi.hoisted(() => vi.fn(() => ({})));
const admissionControllerMock = vi.hoisted(() => ({
  acquire: vi.fn(() => ({ action: 'accept', token: 'admission-token' })),
  release: vi.fn((sessionName: string, token: string) => sessionName === 'deck_current_brain' && token === 'admission-token'),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  listSessions: listSessionsMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitMock, on: vi.fn() },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/daemon/daemon-task-admission.js', () => ({
  getDaemonTaskAdmissionController: () => admissionControllerMock,
}));

import { startHookServer } from '../../src/daemon/hook-server.js';
import { clearCapabilityAuthorizationKeys, setCapabilityAuthority } from '../../src/capability/capability-authorization.js';
import { MEMORY_MCP_DAEMON_RPC_PATH } from '../../shared/memory-mcp-daemon-rpc.js';

function postNotify(port: number, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ agent: false, hostname: '127.0.0.1', port, path: '/notify', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postCapabilityIdentity(
  port: number,
  sessionName: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      agent: false, hostname: '127.0.0.1', port, path: '/capability-identity', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-imcodes-session': sessionName },
    }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: response }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function postResourceAdmission(
  port: number,
  sessionName: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      agent: false, hostname: '127.0.0.1', port, path: '/resource-admission', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-imcodes-session': sessionName },
    }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(response) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function postMemoryMcpDaemonTool(
  port: number,
  sessionName: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      agent: false, hostname: '127.0.0.1', port, path: MEMORY_MCP_DAEMON_RPC_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-imcodes-session': sessionName },
    }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(response) as Record<string, unknown> }));
    });
    req.on('error', reject);
    req.end(data);
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

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearCapabilityAuthorizationKeys('owner-1', 'server-1');
    clearCapabilityAuthorizationKeys('owner-2', 'server-1');
  });

  it('resolves capability context from the registered node and exact stored session', async () => {
    expect(setCapabilityAuthority('owner-1', 'server-1', 1, [], [])).toBe(true);
    getSessionMock.mockImplementation((name: string) => ({
      name, providerId: 'codex-sdk', agentType: 'codex-sdk', projectDir: '',
      contextNamespace: { scope: 'personal' },
    }));
    await expect(postCapabilityIdentity(port, 'deck_current_brain', {
      providerId: 'codex-sdk', serverId: 'server-1',
    })).resolves.toMatchObject({ status: 200 });
    await expect(postCapabilityIdentity(port, 'deck_current_brain', {
      providerId: 'pi', serverId: 'server-1',
    })).resolves.toMatchObject({ status: 403 });
  });

  it('uses the current registered-node owner after authority changes', async () => {
    getSessionMock.mockImplementation((name: string) => ({
      name, providerId: 'codex-sdk', agentType: 'codex-sdk', projectDir: '',
      contextNamespace: { scope: 'personal' },
    }));
    expect(setCapabilityAuthority('owner-1', 'server-1', 1, [], [])).toBe(true);
    await expect(postCapabilityIdentity(port, 'deck_restored_brain', {
      providerId: 'codex-sdk', serverId: 'server-1',
    })).resolves.toMatchObject({ status: 200 });

    expect(setCapabilityAuthority('owner-2', 'server-1', 2, [], [])).toBe(true);
    const response = await postCapabilityIdentity(port, 'deck_restored_brain', {
      providerId: 'codex-sdk', serverId: 'server-1',
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ownerId: 'owner-2' });
  });

  it('rejects hook when session does not exist in store', async () => {
    getSessionMock.mockReturnValue(null);

    const res = await postNotify(port, { event: 'tool_start', session: 'deck_unknown', tool: 'Read' });

    expect(res.status).toBe(200);
    expect(res.body).toBe('ignored');
    expect(timelineEmitMock).not.toHaveBeenCalledWith('deck_unknown', 'tool.call', expect.anything(), expect.anything());
    expect(hookCallback).not.toHaveBeenCalled();
  });

  it('binds task-memory admission reservations to the exact live session', async () => {
    getSessionMock.mockImplementation((name: string) => name === 'deck_current_brain'
      ? { name, state: 'idle', runtimeType: 'transport', sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1' }
      : null);
    const identity = { sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1' };
    const acquired = await postResourceAdmission(port, 'deck_current_brain', { operation: 'acquire', ...identity });
    expect(acquired).toMatchObject({ status: 200, body: { ok: true, action: 'accept' } });
    const token = acquired.body.token;
    expect(typeof token).toBe('string');
    await expect(postResourceAdmission(port, 'deck_other_brain', { operation: 'release', token }))
      .resolves.toMatchObject({ status: 403 });
    await expect(postResourceAdmission(port, 'deck_current_brain', { operation: 'release', token, ...identity }))
      .resolves.toMatchObject({ status: 200, body: { ok: true, released: true } });
  });

  it('rejects a stale runtime epoch before reserving daemon memory', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_current_brain', state: 'idle', runtimeType: 'transport',
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-current',
    });
    await expect(postResourceAdmission(port, 'deck_current_brain', {
      operation: 'acquire', sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-old',
    })).resolves.toMatchObject({
      status: 409,
      body: { ok: false, error: 'task_admission_stale_runtime' },
    });
  });

  it('binds daemon memory tools to the exact runtime and stored namespace', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const invokeMemoryMcpTool = vi.fn(async () => ({ status: 'ok', items: [] }));
    const restarted = await startHookServer(hookCallback, { invokeMemoryMcpTool });
    server = restarted.server;
    port = restarted.port;
    expect(setCapabilityAuthority('owner-1', 'server-1', 1, [], [])).toBe(true);
    getSessionMock.mockReturnValue({
      name: 'deck_current_brain', state: 'idle', agentType: 'codex-sdk', providerId: 'codex-sdk',
      projectName: 'current', projectDir: '/tmp/current',
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1',
      contextNamespace: { scope: 'user_private', userId: 'owner-1', projectId: 'repo-1' },
    });

    const response = await postMemoryMcpDaemonTool(port, 'deck_current_brain', {
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1', serverId: 'server-1',
      tool: 'search_memory', input: { query: 'worker sharing' },
    });

    expect(response).toMatchObject({ status: 200, body: { ok: true, result: { status: 'ok', items: [] } } });
    expect(invokeMemoryMcpTool).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1',
      namespace: { scope: 'user_private', userId: 'owner-1', projectId: 'repo-1' },
      sessionName: 'deck_current_brain',
      transport: 'in_process',
    }), 'search_memory', { query: 'worker sharing' });
  });

  it('routes identity refresh through the live daemon and accepts a protocol-max identity document', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const invokeMemoryMcpTool = vi.fn(async () => ({ status: 'ok', applied: true }));
    const restarted = await startHookServer(hookCallback, { invokeMemoryMcpTool });
    server = restarted.server;
    port = restarted.port;
    expect(setCapabilityAuthority('owner-1', 'server-1', 1, [], [])).toBe(true);
    getSessionMock.mockReturnValue({
      name: 'deck_current_brain', state: 'idle', agentType: 'codex-sdk', providerId: 'codex-sdk',
      projectName: 'current', projectDir: '/tmp/current', role: 'brain',
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1',
      contextNamespace: { scope: 'user_private', userId: 'owner-1', projectId: 'repo-1' },
    });

    const response = await postMemoryMcpDaemonTool(port, 'deck_current_brain', {
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1', serverId: 'server-1',
      tool: 'session_identity_set',
      input: { identityScope: 'session', content: '界'.repeat(30_000) },
    });

    expect(response).toMatchObject({ status: 200, body: { ok: true, result: { status: 'ok', applied: true } } });
    const [forwardedCaller, forwardedTool, forwardedInput] = invokeMemoryMcpTool.mock.calls[0]!;
    expect(forwardedCaller).toMatchObject({ sessionName: 'deck_current_brain', serverId: 'server-1' });
    expect(forwardedTool).toBe('session_identity_set');
    expect(forwardedInput).toMatchObject({ identityScope: 'session' });
    expect((forwardedInput as { content: string }).content).toBe('界'.repeat(30_000));
  });

  it('accepts a legacy daemon-local namespace only for the daemon-bound server', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const invokeMemoryMcpTool = vi.fn(async () => ({ status: 'ok', items: [] }));
    const restarted = await startHookServer(hookCallback, {
      invokeMemoryMcpTool,
      memoryMcpServerId: 'server-1',
    });
    server = restarted.server;
    port = restarted.port;
    expect(setCapabilityAuthority('owner-1', 'server-1', 1, [], [])).toBe(true);
    getSessionMock.mockReturnValue({
      name: 'deck_current_brain', state: 'idle', agentType: 'codex-sdk', providerId: 'codex-sdk',
      projectName: 'current', projectDir: '/tmp/current',
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1',
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
    });

    await expect(postMemoryMcpDaemonTool(port, 'deck_current_brain', {
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1', serverId: 'server-1',
      tool: 'search_memory', input: { query: 'legacy worker sharing' },
    })).resolves.toMatchObject({ status: 200 });
    expect(invokeMemoryMcpTool).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'daemon-local',
      namespace: { scope: 'personal', userId: 'daemon-local', projectId: 'repo-1' },
      serverId: 'server-1',
    }), 'search_memory', { query: 'legacy worker sharing' });

    await expect(postMemoryMcpDaemonTool(port, 'deck_current_brain', {
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1', serverId: 'server-other',
      tool: 'search_memory', input: {},
    })).resolves.toMatchObject({ status: 403 });
  });

  it('rejects stale or non-memory daemon worker requests before dispatch', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_current_brain', state: 'idle', agentType: 'codex-sdk',
      projectName: 'current', projectDir: '/tmp/current',
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-current',
      contextNamespace: { scope: 'user_private', userId: 'owner-1', projectId: 'repo-1' },
    });
    await expect(postMemoryMcpDaemonTool(port, 'deck_current_brain', {
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-old', tool: 'search_memory', input: {},
    })).resolves.toMatchObject({ status: 409 });
    await expect(postMemoryMcpDaemonTool(port, 'deck_current_brain', {
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-current', tool: 'list_machines', input: {},
    })).resolves.toMatchObject({ status: 400 });
  });

  it('rejects a server authority owned by a different memory user', async () => {
    expect(setCapabilityAuthority('other-owner', 'server-other', 1, [], [])).toBe(true);
    getSessionMock.mockReturnValue({
      name: 'deck_current_brain', state: 'idle', agentType: 'codex-sdk',
      projectName: 'current', projectDir: '/tmp/current',
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-current',
      contextNamespace: { scope: 'user_private', userId: 'owner-1', projectId: 'repo-1' },
    });

    await expect(postMemoryMcpDaemonTool(port, 'deck_current_brain', {
      sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-current',
      serverId: 'server-other', tool: 'search_memory', input: {},
    })).resolves.toMatchObject({ status: 403 });
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
