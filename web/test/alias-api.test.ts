import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the network layer (apiFetch); exercise the REAL alias API client so
// the request PATH is asserted end-to-end. Keep ApiError intact for error paths.
const apiFetchMock = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/api.js')>();
  return { ...orig, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

describe('deleteAlias request path (I1 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({ ok: true });
  });

  it('DELETEs via the /:name PATH param, not a ?name= query param', async () => {
    const { deleteAlias } = await import('../src/api/aliases.js');
    await deleteAlias('deploy');

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    // Server route is DELETE /api/aliases/:name — the name must ride the path.
    expect(path).toBe('/api/aliases/deploy');
    expect(init).toMatchObject({ method: 'DELETE' });
    // It must NOT use the old broken query-param form (which 404s against /:name).
    expect(path).not.toContain('?name=');
    expect(path).not.toContain('?');
  });

  it('percent-encodes a CJK name into the /:name path segment', async () => {
    const { deleteAlias } = await import('../src/api/aliases.js');
    await deleteAlias('win服务器');

    const [path] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    // Hono decodes the path param server-side, so the wire form is percent-encoded.
    expect(path).toBe(`/api/aliases/${encodeURIComponent('win服务器')}`);
    expect(path).toBe('/api/aliases/win%E6%9C%8D%E5%8A%A1%E5%99%A8');
    expect(path).not.toContain('?name=');
  });
});
