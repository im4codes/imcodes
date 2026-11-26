import { describe, expect, it, vi } from 'vitest';
import { fetchBackendSharedContextRuntimeConfig } from '../../src/context/backend-runtime-config.js';
import {
  SHARED_CONTEXT_RUNTIME_BACKENDS,
  SHARED_CONTEXT_RUNTIME_CAPABILITY_PROTOCOL,
} from '../../shared/shared-context-runtime-config.js';

describe('fetchBackendSharedContextRuntimeConfig', () => {
  it('normalizes the backend response into an effective runtime config and advertises supported backends', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        config: {
          primaryContextBackend: 'agy-sdk',
          primaryContextModel: 'gemini-3.8-flash-low',
          backupContextBackend: 'opencode-sdk',
          backupContextModel: 'opencode/big-pickle',
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
      modelSelectionMode: 'manual',
      primaryContextBackend: 'agy-sdk',
      primaryContextModel: 'gemini-3.8-flash-low',
      backupContextBackend: 'opencode-sdk',
      backupContextModel: 'opencode/big-pickle',
      memoryRecallMinScore: 0.41,
      memoryScoringWeights: {
        similarity: 0.5,
        recency: 0.2,
        frequency: 0.1,
        project: 0.2,
      },
      enablePersonalMemorySync: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/server/srv-1/shared-context/runtime-config/daemon',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          [SHARED_CONTEXT_RUNTIME_CAPABILITY_PROTOCOL.HTTP_BACKENDS_HEADER]: SHARED_CONTEXT_RUNTIME_BACKENDS.join(','),
        }),
      }),
    );
  });

  it('normalizes legacy qwen and deprecated spark codex responses while keeping legacy non-mode manual presets intact even under active Codex sessions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        config: {
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-5.3-codex-spark',
          backupContextBackend: 'qwen',
          backupContextModel: 'qwen3-coder-plus',
          enablePersonalMemorySync: true,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBackendSharedContextRuntimeConfig({
      workerUrl: 'https://example.test',
      serverId: 'srv-1',
      token: 'secret',
    })).resolves.toMatchObject({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-6-luna',
      backupContextBackend: 'codex-sdk',
      backupContextModel: 'gpt-6-luna',
      enablePersonalMemorySync: true,
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: {
          primaryContextBackend: 'claude-code-sdk',
          primaryContextModel: 'MiniMax-M2.7',
          primaryContextPreset: 'MiniMax',
          enablePersonalMemorySync: true,
        },
      }),
    });
    const legacyManual = await fetchBackendSharedContextRuntimeConfig({
      workerUrl: 'https://example.test',
      serverId: 'srv-1',
      token: 'secret',
    });
    expect(legacyManual.modelSelectionMode).toBe('manual');
    const { resolveEffectiveSharedContextRuntimeConfig } = await import('../../shared/shared-context-runtime-config.js');
    expect(resolveEffectiveSharedContextRuntimeConfig(legacyManual, { sessionAgentType: 'codex-sdk' })).toMatchObject({
      modelSelectionMode: 'manual',
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'MiniMax-M2.7',
      primaryContextPreset: 'MiniMax',
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        config: {
          modelSelectionMode: 'auto',
          primaryContextBackend: 'codex-sdk',
          primaryContextModel: 'gpt-6-luna',
          enablePersonalMemorySync: true,
        },
      }),
    });
    const explicitAuto = await fetchBackendSharedContextRuntimeConfig({
      workerUrl: 'https://example.test',
      serverId: 'srv-1',
      token: 'secret',
    });
    expect(explicitAuto.modelSelectionMode).toBe('auto');
  });
});
