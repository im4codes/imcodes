import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBackendSharedContextNamespace } from '../../src/context/backend-context-namespace.js';

describe('fetchBackendSharedContextNamespace', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetches shared namespace resolution for a canonical repo id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
          workspaceId: 'ws-1',
        },
        canonicalRepoId: 'github.com/acme/repo',
        visibilityState: 'active',
        remoteProcessedFreshness: 'fresh',
        retryExhausted: true,
        sharedPolicyOverride: {
          allowDegradedProvider: true,
          allowLocalProcessedFallback: false,
          requireFullProviderSupport: false,
        },
        diagnostics: ['visibility:active'],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchBackendSharedContextNamespace({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    }, 'github.com/acme/repo');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://worker.test/api/server/srv-1/shared-context/resolve-namespace',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer daemon-token',
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      namespace: expect.objectContaining({
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
      }),
      remoteProcessedFreshness: 'fresh',
      diagnostics: ['visibility:active'],
    }));
  });

  it('fails closed when backend namespace resolution fetch fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBackendSharedContextNamespace({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    }, 'github.com/acme/repo')).rejects.toThrow(/backend_context_namespace_resolution_failed:503/);
  });
});
