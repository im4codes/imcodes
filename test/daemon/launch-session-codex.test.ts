import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  extractNewRolloutUuid: vi.fn(),
  upsertSession: vi.fn(),
  newSession: vi.fn().mockResolvedValue(undefined),
}));

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
  extractNewRolloutUuid: mocks.extractNewRolloutUuid,
  findRolloutPathByUuid: vi.fn().mockResolvedValue('/proj/rollout.jsonl'),
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

import { launchSession } from '../../src/agent/session-manager.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('launchSession — Codex ID handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('awaits extractNewRolloutUuid and saves it to store before finishing', async () => {
    // Simulate extractNewRolloutUuid taking some time
    mocks.extractNewRolloutUuid.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 100));
      return 'new-codex-uuid';
    });

    await launchSession({
      name: 'deck_codex_brain',
      projectName: 'test',
      role: 'brain',
      agentType: 'codex',
      projectDir: '/proj',
    });

    // Verify extractNewRolloutUuid was called
    expect(mocks.extractNewRolloutUuid).toHaveBeenCalled();

    // Verify upsertSession was called WITH the new UUID
    // launchSession calls upsertSession multiple times (paneId update, record creation, UUID update)
    // The LAST call should have the UUID.
    const upsertCalls = mocks.upsertSession.mock.calls;
    const lastRecord = upsertCalls[upsertCalls.length - 1][0];
    expect(lastRecord.codexSessionId).toBe('new-codex-uuid');
  });
});
