import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBackendManagedAuthoredContext } from '../../src/context/backend-authored-context.js';

describe('fetchBackendManagedAuthoredContext', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('skips daemon fetch for personal namespaces', async () => {
    const bindings = await fetchBackendManagedAuthoredContext({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    }, {
      namespace: {
        scope: 'personal',
        projectId: 'repo-1',
        userId: 'user-1',
      },
      language: 'typescript',
      filePath: 'src/index.ts',
    });

    expect(bindings).toEqual([]);
  });

  it('fetches backend-managed authored bindings for shared namespaces', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        bindings: [
          {
            bindingId: 'binding-project',
            documentVersionId: 'doc-v2',
            mode: 'required',
            scope: 'project_shared',
            repository: 'github.com/acme/repo',
            language: 'typescript',
            pathPattern: 'src/**',
            content: 'Project coding standard',
            active: true,
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bindings = await fetchBackendManagedAuthoredContext({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    }, {
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
        workspaceId: 'ws-1',
      },
      language: 'typescript',
      filePath: 'src/index.ts',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://worker.test/api/server/srv-1/shared-context/authored-bindings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer daemon-token',
        }),
      }),
    );
    expect(bindings).toEqual([
      expect.objectContaining({
        bindingId: 'binding-project',
        documentVersionId: 'doc-v2',
        mode: 'required',
      }),
    ]);
  });

  it('fails closed when backend-managed authored context fetch fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBackendManagedAuthoredContext({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    }, {
      namespace: {
        scope: 'org_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
    })).rejects.toThrow(/backend_authored_context_fetch_failed:503/);
  });
});
