import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  persistSessionRecord: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(),
  upsertSession: vi.fn(),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { refreshCodexQuotaMetadataForSessions } from '../../src/daemon/codex-quota-refresh.js';
import { getCodexRuntimeConfig } from '../../src/agent/codex-runtime-config.js';
import { persistSessionRecord } from '../../src/agent/session-manager.js';
import { listSessions, upsertSession } from '../../src/store/session-store.js';

function makeSession(name: string, agentType: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    projectName: 'deck',
    role: 'brain',
    agentType,
    projectDir: '/tmp/project',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SessionRecord;
}

describe('refreshCodexQuotaMetadataForSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('force-refreshes codex quota metadata and broadcasts every codex session', async () => {
    vi.mocked(getCodexRuntimeConfig).mockResolvedValue({
      planLabel: 'Plus',
      quotaLabel: '5h 0% 5h00m',
      quotaMeta: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 2000 } },
      availableModels: ['gpt-5.5'],
    });
    vi.mocked(listSessions).mockReturnValue([
      makeSession('deck_main_brain', 'codex-sdk', { quotaLabel: '5h 90%', quotaMeta: { primary: { usedPercent: 90 } } }),
      makeSession('deck_sub_cx', 'codex', { parentSession: 'deck_main_brain', quotaLabel: '5h 90%' }),
      makeSession('deck_qwen', 'qwen', { quotaLabel: 'today 10/1000' }),
    ]);

    await expect(refreshCodexQuotaMetadataForSessions()).resolves.toBe(2);

    expect(getCodexRuntimeConfig).toHaveBeenCalledWith({ force: true });
    expect(upsertSession).toHaveBeenCalledTimes(2);
    expect(persistSessionRecord).toHaveBeenCalledTimes(2);
    expect(vi.mocked(upsertSession).mock.calls.map(([record]) => record.name)).toEqual(['deck_main_brain', 'deck_sub_cx']);
    expect(vi.mocked(upsertSession).mock.calls[0]?.[0].quotaLabel).toBe('5h 0% 5h00m');
    expect(vi.mocked(upsertSession).mock.calls[1]?.[0].quotaMeta?.primary?.usedPercent).toBe(0);
  });

  it('does not persist when the refreshed display matches current metadata', async () => {
    vi.mocked(getCodexRuntimeConfig).mockResolvedValue({
      quotaLabel: '5h 0% 5h00m',
      quotaMeta: { primary: { usedPercent: 0 } },
      availableModels: ['gpt-5.5'],
    });
    vi.mocked(listSessions).mockReturnValue([
      makeSession('deck_main_brain', 'codex-sdk', {
        quotaLabel: '5h 0% 5h00m',
        quotaMeta: { primary: { usedPercent: 0 } },
        codexAvailableModels: ['gpt-5.5'],
      }),
    ]);

    await expect(refreshCodexQuotaMetadataForSessions()).resolves.toBe(0);

    expect(upsertSession).not.toHaveBeenCalled();
    expect(persistSessionRecord).not.toHaveBeenCalled();
  });
});
