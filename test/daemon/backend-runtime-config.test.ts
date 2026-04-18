import { describe, expect, it, vi } from 'vitest';
import { fetchBackendSharedContextRuntimeConfig } from '../../src/context/backend-runtime-config.js';

describe('fetchBackendSharedContextRuntimeConfig', () => {
  it('normalizes the backend response into an effective runtime config', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        config: {
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-5.4',
          backupContextBackend: 'claude-code-sdk',
          backupContextModel: 'haiku',
          memoryRecallMinScore: 0.41,
          memoryScoringWeights: {
            similarity: 0.5,
            recency: 0.2,
            frequency: 0.1,
            project: 0.2,
          },
          enablePersonalMemorySync: true,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBackendSharedContextRuntimeConfig({
      workerUrl: 'https://example.test',
      serverId: 'srv-1',
      token: 'secret',
    })).resolves.toEqual({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.4',
      backupContextBackend: 'claude-code-sdk',
      backupContextModel: 'haiku',
      memoryRecallMinScore: 0.41,
      memoryScoringWeights: {
        similarity: 0.5,
        recency: 0.2,
        frequency: 0.1,
        project: 0.2,
      },
      enablePersonalMemorySync: true,
    });
  });
});
