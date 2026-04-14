import { describe, expect, it, vi } from 'vitest';
import { fetchBackendSharedContextRuntimeConfig } from '../../src/context/backend-runtime-config.js';

describe('fetchBackendSharedContextRuntimeConfig', () => {
  it('normalizes the backend response into an effective runtime config', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        config: {
          primaryContextModel: 'gpt-5.4',
          backupContextModel: 'haiku',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBackendSharedContextRuntimeConfig({
      workerUrl: 'https://example.test',
      serverId: 'srv-1',
      token: 'secret',
    })).resolves.toEqual({
      primaryContextModel: 'gpt-5.4',
      backupContextModel: 'haiku',
    });
  });
});
