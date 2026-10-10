import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/agent/tmux.js', () => ({
  detectBackend: vi.fn(() => ({})),
  getBackend: vi.fn(() => ({})),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getTransportRuntime: vi.fn(() => undefined),
}));

vi.mock('../../src/agent/agy-usage-quota.js', () => ({
  fetchAgyUsageQuota: vi.fn(async () => null),
  recordAgyQuotaActivity: vi.fn(),
}));

import {
  getSession,
  listSessions,
  removeSession,
  upsertSession,
  type SessionRecord,
} from '../../src/store/session-store.js';
import { buildSessionList } from '../../src/daemon/session-list.js';
import {
  sanitizeProviderQuotaMeta,
  type ProviderQuotaMeta,
} from '../../shared/provider-quota.js';
import {
  AGY_SDK_PROVIDER_ID,
  PROVIDER_QUOTA_GROUP_ID,
  PROVIDER_QUOTA_GROUP_LABEL,
} from '../../shared/agy-agent.js';

describe('session-store and session-list quota groups round-trip', () => {
  const sessionName = 'deck_roundtrip_brain';

  beforeEach(() => {
    for (const s of listSessions()) removeSession(s.name);
  });

  const testQuotaMeta: ProviderQuotaMeta = {
    groups: [
      {
        id: PROVIDER_QUOTA_GROUP_ID.GEMINI,
        label: PROVIDER_QUOTA_GROUP_LABEL.GEMINI,
        primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 5, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      },
      {
        id: PROVIDER_QUOTA_GROUP_ID.CLAUDE_GPT,
        label: PROVIDER_QUOTA_GROUP_LABEL.CLAUDE_GPT,
        primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1_800_010_000 },
        secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
      },
    ],
  };

  it('preserves quotaMeta groups across session-store upsert and retrieval', () => {
    const record: SessionRecord = {
      name: sessionName,
      projectName: 'testproj',
      role: 'brain',
      agentType: AGY_SDK_PROVIDER_ID,
      runtimeType: 'transport',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      quotaLabel: 'Gemini 5h 15% 1h · 7d 5% 5d | Claude/GPT 5h 60% 2h · 7d 30% 6d',
      quotaMeta: testQuotaMeta,
    };

    upsertSession(record);

    const stored = getSession(sessionName);
    expect(stored).toBeDefined();
    expect(stored?.quotaMeta).toEqual(testQuotaMeta);
    expect(stored?.quotaMeta?.groups).toHaveLength(2);
    expect(stored?.quotaMeta?.groups?.[0]?.id).toBe(PROVIDER_QUOTA_GROUP_ID.GEMINI);
    expect(stored?.quotaMeta?.groups?.[1]?.id).toBe(PROVIDER_QUOTA_GROUP_ID.CLAUDE_GPT);
  });

  it('passes through quotaMeta groups in buildSessionList without stripping fields', async () => {
    const record: SessionRecord = {
      name: sessionName,
      projectName: 'testproj',
      role: 'brain',
      agentType: AGY_SDK_PROVIDER_ID,
      runtimeType: 'transport',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      quotaLabel: 'Gemini 5h 15% 1h · 7d 5% 5d | Claude/GPT 5h 60% 2h · 7d 30% 6d',
      quotaMeta: testQuotaMeta,
    };

    upsertSession(record);

    const sessions = await buildSessionList();
    const item = sessions.find((s) => s.name === sessionName);
    expect(item).toBeDefined();
    expect(item?.quotaMeta).toEqual(testQuotaMeta);
  });

  it('sanitizes and round-trips wire quotaMeta objects preserving groups', () => {
    const wireObject = JSON.parse(JSON.stringify(testQuotaMeta)) as unknown;
    const sanitized = sanitizeProviderQuotaMeta(wireObject);
    expect(sanitized).toEqual(testQuotaMeta);
  });
});
