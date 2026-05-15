import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cronMcpCreate,
  cronMcpDelete,
  cronMcpList,
  cronMcpUpdate,
} from '../../src/daemon/cron-mcp-client.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MCP_FEATURE_FLAGS_BY_NAME } from '../../shared/memory-mcp-feature-flags.js';

const credentials = {
  serverId: 'srv-bound',
  token: 'tok-bound',
  workerUrl: 'https://worker.test/',
};

const boundIdentity = {
  credentials,
  runtimeServerId: credentials.serverId,
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

  it('uses pod-sticky /api/server/:serverId/cron and strips forged identity fields', async () => {
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
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok-bound',
      'X-Server-Id': 'srv-bound',
    });
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

  it('short-circuits disabled read and write flags before HTTP', async () => {
    const fetchImpl = vi.fn();

    const read = await cronMcpList({}, {
      ...boundIdentity,
      fetchImpl,
      featureFlags: { [MCP_FEATURE_FLAGS_BY_NAME.cronRead]: false },
    });
    const write = await cronMcpCreate(makeCreateInput(), {
      ...boundIdentity,
      fetchImpl,
      featureFlags: { [MCP_FEATURE_FLAGS_BY_NAME.cronWrite]: false },
    });

    expect(read).toEqual({
      status: 'disabled',
      reason: MCP_ERROR_REASONS.FEATURE_DISABLED,
      disabledFlag: MCP_FEATURE_FLAGS_BY_NAME.cronRead,
    });
    expect(write).toEqual({
      status: 'disabled',
      reason: MCP_ERROR_REASONS.FEATURE_DISABLED,
      disabledFlag: MCP_FEATURE_FLAGS_BY_NAME.cronWrite,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses bound server credentials for update and delete routes', async () => {
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

  it('requires bound server credentials', async () => {
    const fetchImpl = vi.fn();

    const result = await cronMcpList({}, { credentials: null, runtimeServerId: credentials.serverId, fetchImpl });

    expect(result).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects missing or mismatched runtime server identity before HTTP', async () => {
    const fetchImpl = vi.fn();

    await expect(cronMcpList({}, { credentials, fetchImpl })).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
    });
    await expect(cronMcpList({}, {
      credentials,
      runtimeServerId: 'srv-other',
      fetchImpl,
    })).resolves.toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.IDENTITY_REJECTED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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
