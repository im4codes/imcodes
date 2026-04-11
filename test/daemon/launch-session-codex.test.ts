import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  ensureSessionFile: vi.fn().mockResolvedValue('/proj/rollout-seeded.jsonl'),
  upsertSession: vi.fn(),
  newSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => 'new-codex-uuid'),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  upsertSession: mocks.upsertSession,
  getSession: vi.fn(() => null),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: vi.fn().mockResolvedValue([]),
  sessionExists: vi.fn().mockResolvedValue(false),
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  cleanupOrphanFifos: vi.fn(),
  newSession: mocks.newSession,
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  extractNewRolloutUuid: vi.fn(),
  ensureSessionFile: mocks.ensureSessionFile,
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
  preClaimFile: vi.fn(),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  isWatching: vi.fn().mockReturnValue(false),
  preClaimFile: vi.fn(),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  isWatching: vi.fn().mockReturnValue(false),
  preClaimFile: vi.fn(),
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn().mockResolvedValue({
    planLabel: 'Pro',
    quotaLabel: '5h 11% 2h03m 4/5 13:00 · 7d 50% 1d04h 4/7 14:00',
    quotaMeta: {
      primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1_700_100_000 },
    },
  }),
}));

import { launchSession, setSessionEventCallback } from '../../src/agent/session-manager.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('launchSession — Codex ID handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSessionEventCallback(() => {});
  });

  it('assigns an explicit codexSessionId before first launch and persists it', async () => {
    const onSessionEvent = vi.fn();
    setSessionEventCallback(onSessionEvent);

    await launchSession({
      name: 'deck_codex_brain',
      projectName: 'test',
      role: 'brain',
      agentType: 'codex',
      projectDir: '/proj',
    });

    expect(mocks.ensureSessionFile).toHaveBeenCalledWith('new-codex-uuid', '/proj');

    const launchCmd = mocks.newSession.mock.calls[0]?.[1];
    expect(launchCmd).toContain('resume new-codex-uuid');
    expect(launchCmd).not.toContain('resume --last');

    const upsertCalls = mocks.upsertSession.mock.calls;
    const lastRecord = upsertCalls[upsertCalls.length - 1][0];
    expect(lastRecord.codexSessionId).toBe('new-codex-uuid');
    expect(lastRecord.state).toBe('idle');
    expect(lastRecord.quotaMeta).toEqual({
      primary: { usedPercent: 11, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1_700_100_000 },
    });
    expect(onSessionEvent).toHaveBeenCalledWith('started', 'deck_codex_brain', 'idle');
  });
});
