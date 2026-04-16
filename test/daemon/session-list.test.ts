import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  getCodexRuntimeConfig: vi.fn(async () => ({
    planLabel: 'Pro',
    quotaLabel: expect.stringContaining('5h 11%'),
  })),
}));

describe('buildSessionList', () => {
  beforeEach(async () => {
    vi.resetModules();
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
