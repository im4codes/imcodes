import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_ERROR,
  CAPABILITY_KIND,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  type CapabilityOperation,
  type CapabilitySummary,
} from '../../shared/capability-management.js';
import { ServerCapabilityService } from '../../src/capability/server-capability-service.js';

const credentials = { serverId: 'server-1', token: 'daemon-token', workerUrl: 'https://imcodes.example/' };

function operation(overrides: Partial<CapabilityOperation> = {}): CapabilityOperation {
  return {
    id: 'operation-1', kind: CAPABILITY_KIND.SKILL, state: 'awaiting_confirmation', revision: 3,
    scope: CAPABILITY_SCOPE.ACCOUNT, findings: [], providers: [], machines: [],
    hasScripts: false, hasExecutables: false, createdAt: 1, updatedAt: 2, ...overrides,
  };
}

function summary(overrides: Partial<CapabilitySummary> = {}): CapabilitySummary {
  return {
    id: 'skill-1', revision: 2, kind: CAPABILITY_KIND.SKILL, name: 'portable',
    state: CAPABILITY_STATE.ACTIVE, scope: CAPABILITY_SCOPE.ACCOUNT,
    readiness: CAPABILITY_READINESS.READY, findings: [], updatedAt: 2, ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('server-backed capability service', () => {
  it('uses daemon credentials and the server-bound owner API for install', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ operation: operation() }));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    const result = await service.install({
      kind: CAPABILITY_KIND.SKILL,
      source: { kind: CAPABILITY_SOURCE_KIND.URL, value: 'https://example.test/skill.zip' },
      scope: CAPABILITY_SCOPE.ACCOUNT,
      idempotencyKey: 'install-1',
    });
    expect(result).toMatchObject({ status: 'ok', operation: { id: 'operation-1' } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://imcodes.example/api/capabilities/install?serverId=server-1');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer daemon-token', 'X-Server-Id': 'server-1', 'Content-Type': 'application/json' },
    });
  });

  it('re-applies list filters and bounds locally even if the server over-returns', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [
      summary({ id: 'wanted', name: 'Portable Skill' }),
      summary({ id: 'wrong-kind', name: 'Portable MCP', kind: CAPABILITY_KIND.MCP }),
      summary({ id: 'wrong-state', name: 'Portable old', state: CAPABILITY_STATE.DISABLED }),
      summary({ id: 'wrong-name', name: 'Different' }),
    ] }));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    await expect(service.list({
      kind: CAPABILITY_KIND.SKILL,
      state: CAPABILITY_STATE.ACTIVE,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      query: 'portable',
      limit: 1,
    })).resolves.toEqual({ status: 'ok', items: [expect.objectContaining({ id: 'wanted' })] });
  });

  it('cancels through the authoritative operation endpoint and can resolve the revision first', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/operations/operation-1/cancel')) return jsonResponse({ operation: operation({ state: 'cancelled', revision: 4 }) });
      return jsonResponse({ operation: operation() });
    });
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    await expect(service.manage({
      action: CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION,
      operationId: 'operation-1',
    })).resolves.toMatchObject({ status: 'ok', operation: { state: 'cancelled', revision: 4 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [cancelUrl, cancelInit] = fetchImpl.mock.calls[1]!;
    expect(String(cancelUrl)).toContain('/api/capabilities/operations/operation-1/cancel?serverId=server-1');
    expect(JSON.parse(String(cancelInit?.body))).toEqual({ revision: 3 });
  });

  it('returns bounded choices for an ambiguous uninstall name and never guesses a target', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [
      summary({ id: 'skill-account', name: 'portable', scope: CAPABILITY_SCOPE.ACCOUNT }),
      summary({ id: 'skill-project', name: 'portable', scope: CAPABILITY_SCOPE.PROJECT }),
    ] }));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    await expect(service.manage({
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      name: 'portable',
      userIntent: 'uninstall portable',
    })).resolves.toMatchObject({
      status: 'ambiguous',
      choices: [{ id: 'skill-account' }, { id: 'skill-project' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it('auto-selects the only exact binding and sends its opaque id once', async () => {
    const exact = summary({
      bindings: [{
        id: 'binding-only', scope: CAPABILITY_SCOPE.PROJECT, scopeId: 'project-1',
        providers: [], machines: [], active: true,
      }],
    });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      init?.method === 'POST' ? jsonResponse({ capability: exact }) : jsonResponse({ capability: exact })
    ));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    await expect(service.manage({
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      capabilityId: exact.id,
    })).resolves.toMatchObject({ status: 'ok', capability: { id: exact.id } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      capabilityId: exact.id,
      bindingId: 'binding-only',
      expectedRevision: exact.revision,
    });
  });

  it('preserves bounded server 409 binding choices and never retries or guesses a mutation', async () => {
    const exact = summary({ bindings: undefined });
    const choices = [
      {
        id: exact.id, kind: exact.kind, name: exact.name, state: exact.state,
        scope: CAPABILITY_SCOPE.PROJECT, bindingId: 'binding-project', scopeId: 'project-1',
      },
      {
        id: exact.id, kind: exact.kind, name: exact.name, state: exact.state,
        scope: CAPABILITY_SCOPE.SESSION, bindingId: 'binding-session', scopeId: 'session-1',
      },
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      init?.method === 'POST'
        ? jsonResponse({ status: 'error', reason: CAPABILITY_ERROR.AMBIGUOUS, error: CAPABILITY_ERROR.AMBIGUOUS, choices }, 409)
        : jsonResponse({ capability: exact })
    ));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    await expect(service.manage({
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      capabilityId: exact.id,
      userIntent: 'uninstall the selected binding',
    })).resolves.toEqual({ status: 'ambiguous', choices });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).not.toHaveProperty('bindingId');
  });

  it('preserves an authoritative non-retryable 503 for credential deletion', async () => {
    const exact = summary();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      init?.method === 'POST'
        ? jsonResponse({
            status: 'error', reason: CAPABILITY_ERROR.RUNTIME_PENDING,
            error: CAPABILITY_ERROR.RUNTIME_PENDING, retryable: false,
          }, 503)
        : jsonResponse({ capability: exact })
    ));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    await expect(service.manage({
      action: CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS,
      capabilityId: exact.id,
      userIntent: 'delete retained credentials',
    })).resolves.toEqual({
      status: 'error', reason: CAPABILITY_ERROR.RUNTIME_PENDING,
      error: CAPABILITY_ERROR.RUNTIME_PENDING, retryable: false,
    });
  });

  it('keeps a non-ambiguous 409 as a typed retryable conflict', async () => {
    const exact = summary();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => (
      init?.method === 'POST'
        ? jsonResponse({ status: 'error', reason: CAPABILITY_ERROR.CONFLICT, error: CAPABILITY_ERROR.CONFLICT }, 409)
        : jsonResponse({ capability: exact })
    ));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
    });
    await expect(service.manage({
      action: CAPABILITY_MANAGE_ACTION.ROLLBACK,
      capabilityId: exact.id,
      versionId: 'version-1',
    })).resolves.toEqual({
      status: 'error', reason: CAPABILITY_ERROR.CONFLICT,
      error: CAPABILITY_ERROR.CONFLICT, retryable: true,
    });
  });

  it('fails closed without matching credentials and never issues a request', async () => {
    const fetchImpl = vi.fn();
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => ({ ...credentials, serverId: 'server-2' }),
    });
    await expect(service.list({})).resolves.toMatchObject({ status: 'error', reason: CAPABILITY_ERROR.FORBIDDEN });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive request and returns typed retryable runtime_pending', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const service = new ServerCapabilityService({
      serverId: 'server-1', fetchImpl: fetchImpl as typeof fetch,
      loadCredentials: async () => credentials,
      requestTimeoutMs: 5,
    });
    await expect(service.list({})).resolves.toMatchObject({
      status: 'error', reason: CAPABILITY_ERROR.RUNTIME_PENDING, retryable: true,
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
