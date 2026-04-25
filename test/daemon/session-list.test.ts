import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getTransportRuntimeMock, getCodexRuntimeConfigMock } = vi.hoisted(() => ({
  getTransportRuntimeMock: vi.fn(() => undefined),
  getCodexRuntimeConfigMock: vi.fn(async () => ({
    planLabel: 'Pro',
    quotaLabel: '5h 11% 2h03m 4/6 14:40 · 7d 50% 1d04h 4/8 15:48',
    quotaMeta: {
      primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    },
    availableModels: ['gpt-5.5', 'gpt-5.4-mini'],
  })),
}));

vi.mock('../../src/agent/qwen-runtime-config.js', () => ({
  getQwenRuntimeConfig: vi.fn(async () => ({
    authType: 'qwen-oauth',
    authLimit: 'Up to 1,000 requests/day',
    availableModels: ['coder-model'],
  })),
}));

vi.mock('../../src/agent/provider-quota.js', () => ({
  getQwenOAuthQuotaUsageLabel: vi.fn(() => 'today 12/1000 · 1m 1/60'),
}));

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: getCodexRuntimeConfigMock,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: getTransportRuntimeMock,
}));

describe('buildSessionList', () => {
  beforeEach(async () => {
    vi.resetModules();
    getTransportRuntimeMock.mockReset();
    getTransportRuntimeMock.mockReturnValue(undefined);
    getCodexRuntimeConfigMock.mockReset();
    getCodexRuntimeConfigMock.mockResolvedValue({
      planLabel: 'Pro',
      quotaLabel: '5h 11% 2h03m 4/6 14:40 · 7d 50% 1d04h 4/8 15:48',
      quotaMeta: {
        primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      },
      availableModels: ['gpt-5.5', 'gpt-5.4-mini'],
    });
    const store = await import('../../src/store/session-store.js');
    for (const s of store.listSessions()) store.removeSession(s.name);
  });

  it('hydrates missing qwen display metadata from runtime config', async () => {
    const store = await import('../../src/store/session-store.js');
    store.upsertSession({
      name: 'deck_qwen_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'sid-1',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      qwenAuthType: 'qwen-oauth',
      qwenAuthLimit: 'Up to 1,000 requests/day',
      qwenAvailableModels: ['coder-model'],
      modelDisplay: 'coder-model',
      planLabel: 'Free',
      quotaLabel: '1,000/day',
      quotaUsageLabel: 'today 12/1000 · 1m 1/60',
    });
  });

  it('hydrates codex family quota metadata from shared runtime config', async () => {
    const store = await import('../../src/store/session-store.js');
    store.upsertSession({
      name: 'deck_codex_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'codex',
      runtimeType: 'process',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectDir: '/tmp/demo',
    });

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      planLabel: 'Pro',
      quotaLabel: expect.stringContaining('5h 11%'),
      quotaMeta: expect.objectContaining({
        primary: expect.objectContaining({ usedPercent: 11 }),
      }),
      codexAvailableModels: ['gpt-5.5', 'gpt-5.4-mini'],
    });
  });

  it('preserves stored codex quota metadata when runtime quota probing is temporarily empty', async () => {
    getCodexRuntimeConfigMock.mockResolvedValue({
      availableModels: ['gpt-5.5'],
    });
    const store = await import('../../src/store/session-store.js');
    store.upsertSession({
      name: 'deck_codex_stable_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'codex',
      runtimeType: 'process',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectDir: '/tmp/demo',
      planLabel: 'Pro',
      quotaLabel: '5h 22% 1h10m 4/6 14:40 · 7d 44% 1d04h 4/8 15:48',
      quotaMeta: {
        primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      },
      codexAvailableModels: ['gpt-5.4'],
    });

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      planLabel: 'Pro',
      quotaLabel: '5h 22% 1h10m 4/6 14:40 · 7d 44% 1d04h 4/8 15:48',
      quotaMeta: expect.objectContaining({
        primary: expect.objectContaining({ usedPercent: 22 }),
      }),
      codexAvailableModels: ['gpt-5.5'],
    });
    expect(store.getSession('deck_codex_stable_brain')?.quotaLabel).toBe('5h 22% 1h10m 4/6 14:40 · 7d 44% 1d04h 4/8 15:48');
  });

  it('derives transport session state from the live runtime instead of stale persisted store state', async () => {
    const store = await import('../../src/store/session-store.js');
    store.upsertSession({
      name: 'deck_qwen_busy_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'sid-busy',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    getTransportRuntimeMock.mockReturnValue({
      getStatus: () => 'streaming',
      pendingMessages: ['queued second'],
      pendingEntries: [{ clientMessageId: 'msg-2', text: 'queued second' }],
    });

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'deck_qwen_busy_brain',
        state: 'running',
        transportPendingMessages: ['queued second'],
        transportPendingMessageEntries: [{ clientMessageId: 'msg-2', text: 'queued second' }],
      }),
    ]));
  });

  it('preset-backed qwen sessions surface preset model + BYO tier, dropping OAuth labels', async () => {
    const store = await import('../../src/store/session-store.js');
    // Persisted record looks like an OAuth qwen session (e.g. created before
    // the preset was added, or inherited from a stale restart) but now has a
    // ccPreset set. The list surface should treat the preset as authoritative.
    store.upsertSession({
      name: 'deck_qwen_preset_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'sid-preset',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ccPreset: 'minimax',
      qwenModel: 'coder-model',
      qwenAuthType: 'qwen-oauth',
      qwenAuthLimit: 'No longer available',
      qwenAvailableModels: ['coder-model'],
      modelDisplay: 'coder-model',
    });

    // Stub dynamic `./cc-presets.js` import — returns a preset pinned to
    // MiniMax-M2.7 via ANTHROPIC_MODEL.
    vi.doMock('../../src/daemon/cc-presets.js', () => ({
      getPreset: vi.fn(async (name: string) => name === 'minimax'
        ? { name: 'minimax', env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' } }
        : undefined),
      getPresetEffectiveModel: vi.fn((preset: { env?: Record<string, string> }) => preset.env?.ANTHROPIC_MODEL),
      getPresetAvailableModelIds: vi.fn((preset: { env?: Record<string, string> }) => preset.env?.ANTHROPIC_MODEL ? [preset.env.ANTHROPIC_MODEL] : []),
    }));

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      qwenAuthType: 'api-key',
      qwenAvailableModels: ['MiniMax-M2.7'],
      qwenModel: 'MiniMax-M2.7',
      modelDisplay: 'MiniMax-M2.7',
      planLabel: 'BYO',
    });
    expect(sessions[0].qwenAuthLimit).toBeUndefined();
    expect(sessions[0].quotaLabel).toBeUndefined();
    expect(sessions[0].quotaUsageLabel).toBeUndefined();
  });

  it('preset-backed qwen sessions keep discovered model lists and active selected model', async () => {
    const store = await import('../../src/store/session-store.js');
    store.upsertSession({
      name: 'deck_qwen_multi_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'sid-preset-multi',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ccPreset: 'minimax',
      qwenModel: 'MiniMax-Text-01',
      qwenAvailableModels: ['coder-model'],
    });

    vi.doMock('../../src/daemon/cc-presets.js', () => ({
      getPreset: vi.fn(async () => ({
        name: 'minimax',
        env: { ANTHROPIC_MODEL: 'MiniMax-M2.7' },
        defaultModel: 'MiniMax-M2.7',
        availableModels: [
          { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
          { id: 'MiniMax-Text-01' },
        ],
      })),
      getPresetEffectiveModel: vi.fn((preset: { defaultModel?: string; env?: Record<string, string> }) => preset.defaultModel ?? preset.env?.ANTHROPIC_MODEL),
      getPresetAvailableModelIds: vi.fn((preset: { availableModels?: Array<{ id: string }> }) => preset.availableModels?.map((item) => item.id) ?? []),
    }));

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    expect(sessions[0]).toMatchObject({
      qwenAuthType: 'api-key',
      qwenAvailableModels: ['MiniMax-M2.7', 'MiniMax-Text-01'],
      qwenModel: 'MiniMax-Text-01',
      modelDisplay: 'MiniMax-Text-01',
      planLabel: 'BYO',
    });
  });

  it('preserves the session transportConfig snapshot in the list surface', async () => {
    const store = await import('../../src/store/session-store.js');
    store.upsertSession({
      name: 'deck_qwen_brain',
      projectName: 'demo',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'sid-transport',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'qwen',
          model: 'qwen3-coder-plus',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          auditMode: 'audit>plan',
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
    });

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const sessions = await buildSessionList();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      transportConfig: expect.objectContaining({
        supervision: expect.objectContaining({
          mode: 'supervised_audit',
          auditMode: 'audit>plan',
        }),
      }),
    });
  });
});
