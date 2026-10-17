import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBackendSharedContextNamespace } from '../../src/context/backend-context-namespace.js';
import { fetchBackendStartupMemoryItems } from '../../src/context/backend-startup-memory.js';
import {
  BACKEND_CONTEXT_FETCH_DEFAULT_TIMEOUT_MS,
  backendContextFetchSignal,
} from '../../src/context/backend-fetch-timeout.js';
import { BOOTSTRAP_BACKEND_FETCH_TIMEOUT_MS } from '../../src/agent/runtime-context-bootstrap.js';
import { getTransportContextBudgetMs } from '../../src/agent/transport-context-budget.js';

const credentials = { workerUrl: 'https://backend.invalid', serverId: 'srv-1', token: 'tok' };

/** A backend that accepts the connection and never answers; only an abort ends the request. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
  }));
}

describe('backend context fetches never hang', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('namespace resolution against a backend that never answers is aborted at its timeout', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const startedAt = Date.now();
    await expect(fetchBackendSharedContextNamespace(credentials, 'github/acme/repo', { timeoutMs: 60 })).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('remote startup memory against a backend that never answers is aborted at its timeout', async () => {
    const fetchMock = hangingFetch();
    const startedAt = Date.now();
    await expect(fetchBackendStartupMemoryItems(
      credentials,
      { scope: 'personal', projectId: 'github/acme/repo' },
      8,
      { fetchImpl: fetchMock as unknown as typeof fetch, timeoutMs: 60 },
    )).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('a body that stalls after the headers is covered by the same abort', async () => {
    const stalledBody = vi.fn((_url: unknown, init?: RequestInit) => Promise.resolve({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
      }),
    } as unknown as Response));
    vi.stubGlobal('fetch', stalledBody);
    const startedAt = Date.now();
    await expect(fetchBackendSharedContextNamespace(credentials, 'github/acme/repo', { timeoutMs: 60 })
      .then(() => 'ok', () => 'aborted')).resolves.toBe('aborted');
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it('callers that pass nothing still get the generous default rather than an unbounded request', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({ ok: true, json: async () => ({ results: [] }) } as unknown as Response));
    await fetchBackendStartupMemoryItems(credentials, { scope: 'personal', projectId: 'p' }, 4, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(BACKEND_CONTEXT_FETCH_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(backendContextFetchSignal().aborted).toBe(false);
    expect(backendContextFetchSignal(0).aborted).toBe(false);
  });

  it('the bootstrap fetch cap fits inside the default transport context budget', () => {
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '');
    expect(BOOTSTRAP_BACKEND_FETCH_TIMEOUT_MS).toBeLessThan(getTransportContextBudgetMs());
  });
});
