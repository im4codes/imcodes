import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cronMcpCreate,
  cronMcpCreateSelf,
  cronMcpDelete,
  cronMcpList,
  cronMcpUpdate,
} from '../../src/daemon/cron-mcp-client.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';

const endpoint = {
  serverId: 'srv-bound',
  workerUrl: 'https://worker.test/',
};

const boundIdentity = {
  endpoint,
  runtimeServerId: endpoint.serverId,
};

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Daily send',
    cronExpr: '0 9 * * *',
    projectName: 'proj',
    targetRole: 'brain',
    action: { type: 'send', target: 'w1', message: 'please review' },
    ...overrides,
  };
}

describe('cron MCP client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses pod-sticky /api/server/:serverId/cron without auth headers and strips forged identity fields', async () => {
    const fetchImpl = vi.fn(async () => okJson({ id: 'job-1' }));

    const result = await cronMcpCreate(makeCreateInput({
      userId: 'user-forged',
      serverId: 'srv-forged',
      token: 'tok-forged',
      actorId: 'actor-forged',
    }), { ...boundIdentity, fetchImpl });

    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://worker.test/api/server/srv-bound/cron');
    expect(url).not.toContain('/api/cron');
    expect(init.headers).toMatchObject({ 'X-Server-Id': 'srv-bound' });
    expect(init.headers).not.toHaveProperty('Authorization');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.serverId).toBe('srv-bound');
    expect(body.userId).toBeUndefined();
    expect(body.token).toBeUndefined();
    expect(body.actorId).toBeUndefined();
  });

  it('attaches runtime-derived source provenance to structured send actions', async () => {
    const fetchImpl = vi.fn(async () => okJson({ id: 'job-1' }));

    await cronMcpCreate(makeCreateInput({
      sourceSessionName: 'deck_sub_scheduler',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-bound',
      action: {
        type: 'send',
        target: 'w1',
        message: 'please review',
        sourceSessionName: 'deck_sub_forged',
        sourceProjectName: 'other',
        sourceServerId: 'srv-forged',
      },
    }), { ...boundIdentity, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { action: Record<string, unknown> };
    expect(body.action).toMatchObject({
      type: 'send',
      target: 'w1',
      message: 'please review',
      sourceSessionName: 'deck_sub_scheduler',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-bound',
    });
    expect(JSON.stringify(body.action)).not.toContain('deck_sub_forged');
    expect(JSON.stringify(body.action)).not.toContain('srv-forged');
  });

  it('creates a direct command job for the runtime-resolved current session', async () => {
    const fetchImpl = vi.fn(async () => okJson({ id: 'job-self' }));

    const result = await cronMcpCreateSelf({
      name: 'Review status',
      cronExpr: '*/10 * * * *',
      projectName: 'proj',
      targetRole: 'brain',
      targetSessionName: 'deck_sub_scheduler',
      message: 'Review the latest status',
      timezone: 'Asia/Shanghai',
    }, { ...boundIdentity, fetchImpl });

    expect(result.status).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://worker.test/api/server/srv-bound/cron');
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'Review status',
      cronExpr: '*/10 * * * *',
      serverId: 'srv-bound',
      projectName: 'proj',
      targetRole: 'brain',
      targetSessionName: 'deck_sub_scheduler',
      action: { type: 'command', command: 'Review the latest status' },
      timezone: 'Asia/Shanghai',
    });
  });

  it('rejects an empty current-session message before HTTP', async () => {
    const fetchImpl = vi.fn();
    await expect(cronMcpCreateSelf({
      name: 'Empty',
      cronExpr: '*/10 * * * *',
      projectName: 'proj',
      targetRole: 'brain',
      message: '   ',
    }, { ...boundIdentity, fetchImpl })).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-send create actions before HTTP', async () => {
    const fetchImpl = vi.fn();

    const result = await cronMcpCreate(makeCreateInput({
      action: { type: 'command', command: '/status' },
    }), { ...boundIdentity, fetchImpl });

    expect(result).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the 90 day expiresAt cap before HTTP', async () => {
    const fetchImpl = vi.fn();
    const nowMs = 1_000;
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;

    const result = await cronMcpCreate(makeCreateInput({
      expiresAt: nowMs + ninetyDaysMs + 1,
    }), { ...boundIdentity, fetchImpl, nowMs: () => nowMs });

    expect(result).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.VALIDATION_FAILED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clamps list limit to 100 and never calls direct /api/cron', async () => {
    const fetchImpl = vi.fn(async () => okJson({ jobs: [] }));

    const result = await cronMcpList({
      projectName: 'proj',
      limit: 500,
      serverId: 'srv-forged',
      userId: 'user-forged',
      token: 'tok-forged',
      actorId: 'actor-forged',
    }, { ...boundIdentity, fetchImpl });

    expect(result).toMatchObject({ status: 'ok', limit: 100 });
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://worker.test/api/server/srv-bound/cron?limit=100&projectName=proj');
    expect(url).not.toContain('/api/cron');
  });

  it('uses the local daemon endpoint for update and delete routes', async () => {
    const fetchImpl = vi.fn(async () => okJson({ ok: true }));

    await cronMcpUpdate({
      id: 'job-1',
      action: { type: 'send', target: 'w2', message: 'updated' },
      serverId: 'srv-forged',
      userId: 'user-forged',
      token: 'tok-forged',
      actorId: 'actor-forged',
    }, { ...boundIdentity, fetchImpl });
    await cronMcpDelete('job-1', { ...boundIdentity, fetchImpl });

    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe('https://worker.test/api/server/srv-bound/cron/job-1');
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[0]).toBe('https://worker.test/api/server/srv-bound/cron/job-1');
    const updateBody = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(updateBody.serverId).toBeUndefined();
    expect(updateBody.userId).toBeUndefined();
    expect(updateBody.token).toBeUndefined();
    expect(updateBody.actorId).toBeUndefined();
  });

  it('attaches runtime-derived source provenance to update actions', async () => {
    const fetchImpl = vi.fn(async () => okJson({ ok: true }));

    await cronMcpUpdate({
      id: 'job-1',
      sourceSessionName: 'deck_sub_scheduler',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-bound',
      action: {
        type: 'send',
        target: 'w2',
        message: 'updated',
        sourceSessionName: 'deck_sub_forged',
        sourceProjectName: 'other',
        sourceServerId: 'srv-forged',
      },
    }, { ...boundIdentity, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { action: Record<string, unknown> };
    expect(body.action).toMatchObject({
      type: 'send',
      target: 'w2',
      message: 'updated',
      sourceSessionName: 'deck_sub_scheduler',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-bound',
    });
    expect(JSON.stringify(body.action)).not.toContain('deck_sub_forged');
    expect(JSON.stringify(body.action)).not.toContain('srv-forged');
  });

  it('requires a local daemon cron endpoint', async () => {
    const fetchImpl = vi.fn();

    const result = await cronMcpList({}, { endpoint: null, runtimeServerId: endpoint.serverId, fetchImpl });

    expect(result).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the local daemon endpoint without requiring a runtime-bound identity match', async () => {
    const fetchImpl = vi.fn(async () => okJson({ jobs: [] }));

    await expect(cronMcpList({}, { endpoint, fetchImpl })).resolves.toMatchObject({
      status: 'ok',
      limit: 100,
    });
    await expect(cronMcpList({}, {
      endpoint,
      runtimeServerId: 'srv-runtime',
      fetchImpl,
    })).resolves.toMatchObject({
      status: 'ok',
      limit: 100,
    });

    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe('https://worker.test/api/server/srv-bound/cron?limit=100');
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[0]).toBe('https://worker.test/api/server/srv-runtime/cron?limit=100');
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[1].headers).toMatchObject({ 'X-Server-Id': 'srv-runtime' });
    expect((fetchImpl.mock.calls[1] as [string, RequestInit])[1].headers).not.toHaveProperty('Authorization');
  });

  it('does not require or forward a token from the local endpoint config', async () => {
    const fetchImpl = vi.fn(async () => okJson({ jobs: [] }));

    await expect(cronMcpList({}, {
      endpoint: { serverId: 'srv-local', workerUrl: 'http://127.0.0.1:19138' },
      fetchImpl,
    })).resolves.toMatchObject({ status: 'ok' });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'X-Server-Id': 'srv-local' });
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('sanitizes HTTP and thrown errors', async () => {
    const serverErrorFetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'failed at https://worker.test/api/server/srv-bound/cron with token=secret',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    const serverError = await cronMcpList({}, { ...boundIdentity, fetchImpl: serverErrorFetch });
    expect(serverError).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.INTERNAL_ERROR });
    expect(JSON.stringify(serverError)).not.toContain('worker.test');
    expect(JSON.stringify(serverError)).not.toContain('secret');

    const thrownFetch = vi.fn(async () => {
      throw new Error('Bearer tok-bound failed at https://worker.test/api/server/srv-bound/cron\n    at stack');
    });
    const thrownError = await cronMcpList({}, { ...boundIdentity, fetchImpl: thrownFetch });
    expect(thrownError).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.INTERNAL_ERROR });
    expect(JSON.stringify(thrownError)).not.toContain('tok-bound');
    expect(JSON.stringify(thrownError)).not.toContain('worker.test');
    expect(JSON.stringify(thrownError)).not.toContain('at stack');
  });
});
