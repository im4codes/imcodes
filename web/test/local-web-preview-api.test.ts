/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('createLocalWebPreview', () => {
  beforeEach(() => {
    vi.resetModules();
    document.cookie = 'rcc_csrf=test-csrf';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'rcc_csrf=; Max-Age=0; path=/';
  });

  it('unwraps the nested preview payload returned by the server', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      preview: {
        id: 'preview-123',
        url: '/api/server/server-1/local-web/preview-123/docs',
        serverId: 'server-1',
        port: 3000,
        path: '/docs',
        expiresAt: '2026-03-29T00:00:00.000Z',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { createLocalWebPreview } = await import('../src/api.js');
    const result = await createLocalWebPreview('server-1', 3000, '/docs');

    expect(result).toEqual({
      previewId: 'preview-123',
      previewUrl: '/api/server/server-1/local-web/preview-123/docs',
      serverId: 'server-1',
      port: 3000,
      path: '/docs',
      expiresAt: '2026-03-29T00:00:00.000Z',
    });
  });
});
