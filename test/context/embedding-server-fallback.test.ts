/**
 * Tests for `src/context/embedding-server-fallback.ts`.
 *
 * The fallback is the daemon's last-resort path when the local pipeline
 * sticky-disables (sharp empty placeholders, onnxruntime can't dlopen).
 * We mock `loadCredentials` and `fetch` so the test never touches the
 * filesystem or the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIM } from '../../shared/embedding-config.js';

// Mock the bind-flow module that `embedding-server-fallback` dynamic-imports.
// `vi.mock` is hoisted to the top of the file before any imports run, so the
// daemon's dynamic `import('../bind/bind-flow.js')` resolves to this stub.
vi.mock('../../src/bind/bind-flow.js', () => ({
  loadCredentials: vi.fn(),
}));

import { loadCredentials } from '../../src/bind/bind-flow.js';
const loadCredentialsMock = loadCredentials as unknown as ReturnType<typeof vi.fn>;

async function loadModule() {
  return await import('../../src/context/embedding-server-fallback.js');
}

beforeEach(async () => {
  loadCredentialsMock.mockReset();
  const m = await loadModule();
  m._resetServerFallbackStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFakeEmbedding(seed = 0): number[] {
  const out = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] = (i + seed) * 0.001;
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('tryServerEmbedding — credential gating', () => {
  it('sticky-disables with reason "not_bound" when no credentials are present', async () => {
    loadCredentialsMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hello', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).toBeNull();
    expect(m.isServerFallbackUnavailable()).toBe(true);
    expect(m.getServerFallbackDisableReason()).toBe('not_bound');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only reads credentials once across many calls (caches the lookup)', async () => {
    loadCredentialsMock.mockResolvedValue({
      serverId: 'srv-1', token: 'tok', workerUrl: 'https://example.com',
    });
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, dim: EMBEDDING_DIM, embedding: makeFakeEmbedding() }));
    const m = await loadModule();
    await m.tryServerEmbedding('a', { fetchImpl: fetchMock as unknown as typeof fetch });
    await m.tryServerEmbedding('b', { fetchImpl: fetchMock as unknown as typeof fetch });
    await m.tryServerEmbedding('c', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(loadCredentialsMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('tryServerEmbedding — request shape', () => {
  beforeEach(() => {
    loadCredentialsMock.mockResolvedValue({
      serverId: 'srv-42',
      token: 'tok-secret',
      workerUrl: 'https://imcodes.example.com/',  // trailing slash on purpose
    });
  });

  it('posts JSON to /api/embedding on the bound workerUrl', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, dim: EMBEDDING_DIM, embedding: makeFakeEmbedding(7) }));
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hello world', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).not.toBeNull();
    expect(v).toBeInstanceOf(Float32Array);
    expect(v!.length).toBe(EMBEDDING_DIM);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    // Trailing slash on workerUrl must not produce //api/embedding.
    expect(url).toBe('https://imcodes.example.com/api/embedding');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-secret');
    expect(headers['X-Server-Id']).toBe('srv-42');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ text: 'hello world' });
  });

  it('passes the AbortSignal so timeouts can cancel the inflight request', async () => {
    let captured: AbortSignal | null = null;
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      captured = init.signal ?? null;
      return jsonResponse({ ok: true, dim: EMBEDDING_DIM, embedding: makeFakeEmbedding() });
    });
    const m = await loadModule();
    await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(captured).not.toBeNull();
    expect(captured).toBeInstanceOf(AbortSignal);
  });
});

describe('tryServerEmbedding — server-failure modes', () => {
  beforeEach(() => {
    loadCredentialsMock.mockResolvedValue({
      serverId: 'srv', token: 'tok', workerUrl: 'https://example.com',
    });
  });

  it('sticky-disables with "unauthorized" on 401 (token revoked / rebind needed)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    const m = await loadModule();
    const first = await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(first).toBeNull();
    expect(m.isServerFallbackUnavailable()).toBe(true);
    expect(m.getServerFallbackDisableReason()).toBe('unauthorized');

    // Subsequent calls short-circuit; fetch is not invoked again.
    const second = await m.tryServerEmbedding('hi again', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sticky-disables with "unauthorized" on 403 too', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403));
    const m = await loadModule();
    await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(m.getServerFallbackDisableReason()).toBe('unauthorized');
  });

  it('sticky-disables with "server_unavailable" on 503 (server pool also dead)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: 'embedding_unavailable' }, 503));
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).toBeNull();
    expect(m.getServerFallbackDisableReason()).toBe('server_unavailable');
  });

  it('does NOT sticky-disable on transient 504 timeout', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false, error: 'embedding_timeout' }, 504));
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).toBeNull();
    expect(m.isServerFallbackUnavailable()).toBe(false);
  });

  it('does NOT sticky-disable on network error (offline / DNS / TLS)', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).toBeNull();
    expect(m.isServerFallbackUnavailable()).toBe(false);
  });
});

describe('tryServerEmbedding — payload validation', () => {
  beforeEach(() => {
    loadCredentialsMock.mockResolvedValue({ serverId: 'x', token: 'y', workerUrl: 'https://e' });
  });

  it('returns null without sticky-disabling on malformed JSON response', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }));
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).toBeNull();
    expect(m.isServerFallbackUnavailable()).toBe(false);
  });

  it('returns null when ok=false in body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: false }));
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).toBeNull();
  });

  it('returns null when embedding has wrong dimension', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, dim: 7, embedding: [0, 0, 0, 0, 0, 0, 0] }));
    const m = await loadModule();
    const v = await m.tryServerEmbedding('hi', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(v).toBeNull();
  });
});
