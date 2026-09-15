/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('session identity API routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('uses the covered-session owner route when editing a live session', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ profile: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        profile: {
          scope: 'project', scopeKey: 'repo/stable', content: 'Participant overwrite',
          contentHash: 'hash', revision: 2, updatedAt: 2, source: 'web',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    const {
      clearSessionIdentityProfile,
      fetchSessionIdentityProfile,
      saveSessionIdentityProfile,
    } = await import('../src/api.js');
    const context = { serverId: 'srv/one', sessionName: 'deck_proj_brain' };

    await fetchSessionIdentityProfile('project', 'repo/stable', context);
    await saveSessionIdentityProfile({
      scope: 'project', scopeKey: 'repo/stable', content: 'Participant overwrite',
    }, context);
    await clearSessionIdentityProfile('project', 'repo/stable', context);

    const path = '/api/server/srv%2Fone/sessions/deck_proj_brain/identity';
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${path}?scope=project&scopeKey=repo%2Fstable`, expect.objectContaining({ cache: 'no-store' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, path, expect.objectContaining({ method: 'PUT' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${path}?scope=project&scopeKey=repo%2Fstable`, expect.objectContaining({ method: 'DELETE' }));
  });
});
