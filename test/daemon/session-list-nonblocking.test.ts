import { beforeEach, describe, expect, it, vi } from 'vitest';

const quotaMocks = vi.hoisted(() => {
  const hangingResolvers: Array<() => void> = [];
  const makeHanging = () => () => new Promise<null>((resolve) => {
    hangingResolvers.push(() => resolve(null));
  });
  return {
    releaseHanging: () => {
      while (hangingResolvers.length > 0) {
        hangingResolvers.pop()?.();
      }
    },
    getQwenRuntimeConfig: vi.fn(async (opts?: unknown) => {
      if (typeof opts !== 'object' || opts === null || (opts as { probe?: boolean }).probe !== false) {
        return makeHanging()();
      }
      return {
        authType: 'qwen-oauth',
        availableModels: ['coder-model'],
      };
    }),
    getClaudeUsageQuota: vi.fn(makeHanging()),
    peekClaudeUsageQuotaCached: vi.fn(() => ({
      quotaLabel: '5h 12% · 7d 34%',
      quotaMeta: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
    })),
    fetchAgyUsageQuota: vi.fn(makeHanging()),
    peekAgyUsageQuotaCached: vi.fn(() => ({
      quotaLabel: 'Gemini 15% · Claude 25%',
      quotaMeta: {
        groups: [
          { id: 'gemini', label: 'Gemini', primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
        ],
      },
    })),
    getGrokUsageQuota: vi.fn(makeHanging()),
    peekGrokUsageQuotaCached: vi.fn(() => ({
      quotaLabel: '31d 8% 12d',
      quotaMeta: {
        primary: { usedPercent: 8, windowDurationMins: 44640, resetsAt: 1_800_900_000 },
      },
    })),
    getMuseUsageQuota: vi.fn(makeHanging()),
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

import { afterEach } from 'vitest';
import { __resetBackgroundQuotaRefreshForTests } from '../../src/daemon/quota-background-refresh.js';
import { buildSessionList } from '../../src/daemon/session-list.js';
import { buildSubSessionSyncPayload, createSubSessionSyncSharedCache } from '../../src/daemon/subsession-sync.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { listSessions, removeSession, upsertSession } from '../../src/store/session-store.js';

describe('non-blocking buildSessionList & buildSubSessionSyncPayload', () => {
  beforeEach(() => {
    quotaMocks.releaseHanging();
    for (const [key, fn] of Object.entries(quotaMocks)) {
      if (key !== 'releaseHanging') (fn as ReturnType<typeof vi.fn>).mockClear();
    }
    __resetBackgroundQuotaRefreshForTests();
    for (const s of listSessions()) removeSession(s.name);
  });

  afterEach(() => {
    quotaMocks.releaseHanging();
  });

  it('returns cached quotas/models in milliseconds even when agy/claude/grok/muse probes hang and deduplicates background refreshes', async () => {
    const now = Date.now();
    for (const [name, agentType] of [
      ['deck_agy_brain', 'agy-sdk'],
      ['deck_claude_brain', 'claude-code-sdk'],
      ['deck_grok_brain', 'grok-sdk'],
      ['deck_muse_brain', 'muse-code-sdk'],
      ['deck_qwen_brain', 'qwen'],
    ] as const) {
      upsertSession({
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
    const now = Date.now();
    for (const [id, agentType] of [
      ['sub_agy', 'agy-sdk'],
      ['sub_claude', 'claude-code-sdk'],
      ['sub_grok', 'grok-sdk'],
      ['sub_muse', 'muse-code-sdk'],
    ] as const) {
      upsertSession({
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

  it('pushes updated claude-code-sdk quota to main session_list without a second get_sessions request and avoids refresh loops', async () => {
    upsertSession({
      name: 'deck_claude_push_brain',
      projectName: 'claude-push',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      providerSessionId: 'sid-claude-push',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let cachedClaudeQuota: { quotaLabel: string; quotaMeta: Record<string, unknown> } | null = null;
    let resolveClaudeProbe!: (v: typeof cachedClaudeQuota) => void;
    const claudeProbePromise = new Promise<typeof cachedClaudeQuota>((resolve) => {
      resolveClaudeProbe = resolve;
    });

    quotaMocks.peekClaudeUsageQuotaCached.mockImplementation(() => cachedClaudeQuota as never);
    quotaMocks.getClaudeUsageQuota.mockImplementation(async () => claudeProbePromise as never);

    const sentFrames: Array<Record<string, unknown>> = [];
    const serverLink = {
      daemonVersion: '1.0.0-test',
      send: vi.fn((frame: Record<string, unknown>) => {
        sentFrames.push(frame);
      }),
    };

    const startMs = Date.now();
    handleWebCommand({ type: 'get_sessions' }, serverLink as never);
    await vi.waitFor(() => expect(sentFrames).toHaveLength(1));
    expect(Date.now() - startMs).toBeLessThan(200);
    expect(sentFrames[0]).toMatchObject({ type: 'session_list' });
    const firstSessions = sentFrames[0]!.sessions as Array<Record<string, unknown>>;
    expect(firstSessions.find((s) => s.name === 'deck_claude_push_brain')?.quotaLabel).toBeUndefined();

    // Now the slow probe resolves with fresh 5h + 7d quota; daemon should auto-push ONE updated session_list.
    const freshQuota = {
      quotaLabel: '5h 18% · 7d 42%',
      quotaMeta: {
        primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
      },
    };
    cachedClaudeQuota = freshQuota;
    resolveClaudeProbe(freshQuota);

    await vi.waitFor(() => expect(sentFrames).toHaveLength(2));
    const secondSessions = sentFrames[1]!.sessions as Array<Record<string, unknown>>;
    expect(secondSessions.find((s) => s.name === 'deck_claude_push_brain')).toMatchObject({
      quotaLabel: '5h 18% · 7d 42%',
      quotaMeta: freshQuota.quotaMeta,
    });

    // Must NOT loop after pushing the new snapshot
    await new Promise((r) => setTimeout(r, 30));
    expect(sentFrames).toHaveLength(2);
  });

  it('queues background authLimit probe for known qwen-oauth sessions and pushes updated session_list once resolved', async () => {
    upsertSession({
      name: 'deck_qwen_oauth_push_brain',
      projectName: 'qwen-push',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      providerId: 'qwen',
      providerSessionId: 'sid-qwen-push',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let qwenProbeResolved = false;
    let resolveQwenProbe!: (v: { authType: string; authLimit: string; availableModels: string[] }) => void;
    const qwenProbePromise = new Promise<{ authType: string; authLimit: string; availableModels: string[] }>((resolve) => {
      resolveQwenProbe = resolve;
    });

    quotaMocks.getQwenRuntimeConfig.mockImplementation(async (opts?: unknown) => {
      const probe = typeof opts === 'object' && opts !== null ? (opts as { probe?: boolean }).probe !== false : true;
      if (!probe) {
        return qwenProbeResolved
          ? { authType: 'qwen-oauth', authLimit: 'Up to 1,000 requests/day', availableModels: ['coder-model'] }
          : { authType: 'qwen-oauth', availableModels: ['coder-model'] };
      }
      return qwenProbePromise as never;
    });

    const sentFrames: Array<Record<string, unknown>> = [];
    const serverLink = {
      daemonVersion: '1.0.0-test',
      send: vi.fn((frame: Record<string, unknown>) => {
        sentFrames.push(frame);
      }),
    };

    handleWebCommand({ type: 'get_sessions' }, serverLink as never);
    await vi.waitFor(() => expect(sentFrames).toHaveLength(1));
    const firstQwen = (sentFrames[0]!.sessions as Array<Record<string, unknown>>)
      .find((s) => s.name === 'deck_qwen_oauth_push_brain');
    expect(firstQwen?.qwenAuthType).toBe('qwen-oauth');
    expect(firstQwen?.qwenAuthLimit).toBeUndefined();

    qwenProbeResolved = true;
    resolveQwenProbe({
      authType: 'qwen-oauth',
      authLimit: 'Up to 1,000 requests/day',
      availableModels: ['coder-model'],
    });

    await vi.waitFor(() => expect(sentFrames).toHaveLength(2));
    const secondQwen = (sentFrames[1]!.sessions as Array<Record<string, unknown>>)
      .find((s) => s.name === 'deck_qwen_oauth_push_brain');
    expect(secondQwen).toMatchObject({
      qwenAuthType: 'qwen-oauth',
      qwenAuthLimit: 'Up to 1,000 requests/day',
      quotaLabel: '1,000/day',
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(sentFrames).toHaveLength(2);
  });
});
