import { beforeEach, describe, expect, it, vi } from 'vitest';

const quotaMocks = vi.hoisted(() => {
  const neverResolving = () => new Promise<never>(() => {});
  return {
    getQwenRuntimeConfig: vi.fn(async (opts?: unknown) => {
      if (typeof opts !== 'object' || opts === null || (opts as { probe?: boolean }).probe !== false) {
        return neverResolving();
      }
      return {
        authType: 'qwen-oauth',
        availableModels: ['coder-model'],
      };
    }),
    getClaudeUsageQuota: vi.fn(neverResolving),
    peekClaudeUsageQuotaCached: vi.fn(() => ({
      quotaLabel: '5h 12% · 7d 34%',
      quotaMeta: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
    })),
    fetchAgyUsageQuota: vi.fn(neverResolving),
    peekAgyUsageQuotaCached: vi.fn(() => ({
      quotaLabel: 'Gemini 15% · Claude 25%',
      quotaMeta: {
        groups: [
          { id: 'gemini', label: 'Gemini', primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
        ],
      },
    })),
    getGrokUsageQuota: vi.fn(neverResolving),
    peekGrokUsageQuotaCached: vi.fn(() => ({
      quotaLabel: '31d 8% 12d',
      quotaMeta: {
        primary: { usedPercent: 8, windowDurationMins: 44640, resetsAt: 1_800_900_000 },
      },
    })),
    getMuseUsageQuota: vi.fn(neverResolving),
    peekMuseUsageQuotaCached: vi.fn(() => ({
      quotaLabel: '5h 5% · 7d 20%',
      quotaMeta: {
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
    })),
  };
});

vi.mock('../../src/agent/qwen-runtime-config.js', () => ({
  getQwenRuntimeConfig: quotaMocks.getQwenRuntimeConfig,
}));

vi.mock('../../src/agent/claude-usage-quota.js', () => ({
  getClaudeUsageQuota: quotaMocks.getClaudeUsageQuota,
  peekClaudeUsageQuotaCached: quotaMocks.peekClaudeUsageQuotaCached,
}));

vi.mock('../../src/agent/agy-usage-quota.js', () => ({
  fetchAgyUsageQuota: quotaMocks.fetchAgyUsageQuota,
  peekAgyUsageQuotaCached: quotaMocks.peekAgyUsageQuotaCached,
}));

vi.mock('../../src/agent/grok-usage-quota.js', () => ({
  getGrokUsageQuota: quotaMocks.getGrokUsageQuota,
  peekGrokUsageQuotaCached: quotaMocks.peekGrokUsageQuotaCached,
}));

vi.mock('../../src/agent/muse-usage-quota.js', () => ({
  getMuseUsageQuota: quotaMocks.getMuseUsageQuota,
  peekMuseUsageQuotaCached: quotaMocks.peekMuseUsageQuotaCached,
}));

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(async () => ({})),
}));

vi.mock('../../src/agent/copilot-runtime-config.js', () => ({
  getCopilotRuntimeConfig: vi.fn(async () => null),
}));

vi.mock('../../src/agent/cursor-runtime-config.js', () => ({
  getCursorRuntimeConfig: vi.fn(async () => null),
}));

describe('non-blocking buildSessionList & buildSubSessionSyncPayload', () => {
  beforeEach(async () => {
    vi.resetModules();
    for (const fn of Object.values(quotaMocks)) {
      fn.mockClear();
    }
    const { __resetBackgroundQuotaRefreshForTests } = await import('../../src/daemon/quota-background-refresh.js');
    __resetBackgroundQuotaRefreshForTests();
    const store = await import('../../src/store/session-store.js');
    for (const s of store.listSessions()) store.removeSession(s.name);
  });

  it('returns cached quotas/models in milliseconds even when agy/claude/grok/muse probes hang and deduplicates background refreshes', async () => {
    const store = await import('../../src/store/session-store.js');
    const now = Date.now();
    for (const [name, agentType] of [
      ['deck_agy_brain', 'agy-sdk'],
      ['deck_claude_brain', 'claude-code-sdk'],
      ['deck_grok_brain', 'grok-sdk'],
      ['deck_muse_brain', 'muse-code-sdk'],
      ['deck_qwen_brain', 'qwen'],
    ] as const) {
      store.upsertSession({
        name,
        projectName: name,
        role: 'brain',
        agentType,
        runtimeType: 'transport',
        providerId: agentType,
        providerSessionId: `sid-${name}`,
        state: 'idle',
        restarts: 0,
        restartTimestamps: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    const { buildSessionList } = await import('../../src/daemon/session-list.js');
    const startMs = Date.now();
    const sessions = await buildSessionList();
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(100);
    expect(sessions).toHaveLength(5);
    expect(quotaMocks.getQwenRuntimeConfig).toHaveBeenCalledWith({ probe: false });
    expect(sessions.find((s) => s.name === 'deck_agy_brain')).toMatchObject({
      quotaLabel: 'Gemini 15% · Claude 25%',
      quotaMeta: { groups: [expect.objectContaining({ id: 'gemini' })] },
    });
    expect(sessions.find((s) => s.name === 'deck_claude_brain')).toMatchObject({
      quotaLabel: '5h 12% · 7d 34%',
    });
    expect(sessions.find((s) => s.name === 'deck_grok_brain')).toMatchObject({
      quotaLabel: '31d 8% 12d',
    });
    expect(sessions.find((s) => s.name === 'deck_muse_brain')).toMatchObject({
      quotaLabel: '5h 5% · 7d 20%',
    });

    // Repeated calls while probes are still in flight must stay non-blocking and never trigger probe storms.
    for (let i = 0; i < 4; i++) {
      await buildSessionList();
    }
    await Promise.resolve();
    expect(quotaMocks.fetchAgyUsageQuota).toHaveBeenCalledTimes(1);
    expect(quotaMocks.getClaudeUsageQuota).toHaveBeenCalledTimes(1);
    expect(quotaMocks.getGrokUsageQuota).toHaveBeenCalledTimes(1);
    expect(quotaMocks.getMuseUsageQuota).toHaveBeenCalledTimes(1);
  });

  it('builds subsession.sync payloads from cached quotas without awaiting slow probes', async () => {
    const store = await import('../../src/store/session-store.js');
    const now = Date.now();
    for (const [id, agentType] of [
      ['sub_agy', 'agy-sdk'],
      ['sub_claude', 'claude-code-sdk'],
      ['sub_grok', 'grok-sdk'],
      ['sub_muse', 'muse-code-sdk'],
    ] as const) {
      store.upsertSession({
        name: `deck_sub_${id}`,
        projectName: 'demo',
        role: 'w1',
        agentType,
        runtimeType: 'transport',
        providerId: agentType,
        providerSessionId: `sid-${id}`,
        parentSession: 'deck_demo_brain',
        state: 'idle',
        restarts: 0,
        restartTimestamps: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    const { buildSubSessionSyncPayload, createSubSessionSyncSharedCache } = await import('../../src/daemon/subsession-sync.js');
    const sharedCache = createSubSessionSyncSharedCache();
    const startMs = Date.now();
    const payloads = await Promise.all([
      buildSubSessionSyncPayload('sub_agy', undefined, { sharedCache }),
      buildSubSessionSyncPayload('sub_claude', undefined, { sharedCache }),
      buildSubSessionSyncPayload('sub_grok', undefined, { sharedCache }),
      buildSubSessionSyncPayload('sub_muse', undefined, { sharedCache }),
    ]);
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(100);
    expect(payloads[0]).toMatchObject({ quotaLabel: 'Gemini 15% · Claude 25%' });
    expect(payloads[1]).toMatchObject({ quotaLabel: '5h 12% · 7d 34%' });
    expect(payloads[2]).toMatchObject({ quotaLabel: '31d 8% 12d' });
    expect(payloads[3]).toMatchObject({ quotaLabel: '5h 5% · 7d 20%' });

    await Promise.resolve();
    expect(quotaMocks.fetchAgyUsageQuota).toHaveBeenCalledTimes(1);
    expect(quotaMocks.getClaudeUsageQuota).toHaveBeenCalledTimes(1);
    expect(quotaMocks.getGrokUsageQuota).toHaveBeenCalledTimes(1);
    expect(quotaMocks.getMuseUsageQuota).toHaveBeenCalledTimes(1);
  });
});
