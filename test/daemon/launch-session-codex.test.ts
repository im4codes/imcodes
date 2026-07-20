import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  store: new Map<string, any>(),
  ensureSessionFile: vi.fn().mockResolvedValue('/proj/rollout-seeded.jsonl'),
  upsertSession: vi.fn(),
  getSession: vi.fn(),
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
  getSession: mocks.getSession,
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

import { launchSession, restartSession, setSessionEventCallback } from '../../src/agent/session-manager.js';
import {
  getSummarySyncFingerprints,
  recordSyncedSummaryFingerprints,
  resetAllSummarySyncHistories,
} from '../../src/context/summary-sync-history.js';
import { fingerprintRecentSummary } from '../../src/context/summary-sync.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('launchSession — Codex ID handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.getSession.mockImplementation((name: string) => mocks.store.get(name));
    mocks.upsertSession.mockImplementation((record: any) => {
      mocks.store.set(record.name, record);
      return record;
    });
    mocks.ensureSessionFile.mockResolvedValue('/proj/rollout-seeded.jsonl');
    resetAllSummarySyncHistories();
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

    expect(mocks.ensureSessionFile).toHaveBeenCalledWith('new-codex-uuid', '/proj', 'deck_codex_brain');

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

  it('persists startup summary fingerprints created before the first SessionRecord', async () => {
    const fingerprint = fingerprintRecentSummary('startup summary delivered in the Codex rollout');
    mocks.ensureSessionFile.mockImplementationOnce(async (_id: string, _dir: string, sessionName: string) => {
      recordSyncedSummaryFingerprints(sessionName, [fingerprint]);
      return '/proj/rollout-seeded.jsonl';
    });

    await launchSession({
      name: 'deck_codex_brain',
      projectName: 'test',
      role: 'brain',
      agentType: 'codex',
      projectDir: '/proj',
    });

    expect(mocks.store.get('deck_codex_brain')?.summarySyncFingerprints).toEqual([fingerprint]);
    resetAllSummarySyncHistories();
    expect(getSummarySyncFingerprints('deck_codex_brain')).toEqual([fingerprint]);
  });

  it('preserves the summary ledger when a missing process pane is restarted non-fresh', async () => {
    const fingerprint = fingerprintRecentSummary('already delivered before crash');
    const record = {
      name: 'deck_codex_brain',
      projectName: 'test',
      role: 'brain',
      agentType: 'codex',
      projectDir: '/proj',
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      codexSessionId: 'existing-codex-thread',
      summarySyncFingerprints: [fingerprint],
    } as any;
    mocks.store.set(record.name, record);

    await expect(restartSession(record)).resolves.toBe(true);

    expect(mocks.store.get(record.name)?.summarySyncFingerprints).toEqual([fingerprint]);
    expect(getSummarySyncFingerprints(record.name)).toEqual([fingerprint]);
  });
});
