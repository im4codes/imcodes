import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  storeListSessions: vi.fn(),
  tmuxListSessions: vi.fn(),
  jsonlStartWatching: vi.fn().mockResolvedValue(undefined),
  jsonlStartWatchingFile: vi.fn().mockResolvedValue(undefined),
  jsonlIsWatching: vi.fn().mockReturnValue(false),
  codexStartWatching: vi.fn().mockResolvedValue(undefined),
  codexStartWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  codexIsWatching: vi.fn().mockReturnValue(false),
  geminiStartWatching: vi.fn().mockResolvedValue(undefined),
  geminiIsWatching: vi.fn().mockReturnValue(false),
  restartSession: vi.fn().mockResolvedValue(true),
  newSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: mocks.storeListSessions,
  upsertSession: vi.fn(),
  getSession: vi.fn((name) => {
    const all = mocks.storeListSessions() || [];
    return all.find(s => s.name === name);
  }),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: mocks.tmuxListSessions,
  sessionExists: vi.fn(async (name) => {
    const live = await mocks.tmuxListSessions();
    return live.includes(name);
  }),
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  cleanupOrphanFifos: vi.fn(),
  newSession: mocks.newSession,
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: mocks.jsonlStartWatching,
  startWatchingFile: mocks.jsonlStartWatchingFile,
  isWatching: mocks.jsonlIsWatching,
  preClaimFile: vi.fn(),
  claudeProjectDir: (d: string) => `/mock/${d}`,
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: mocks.codexStartWatching,
  startWatchingSpecificFile: mocks.codexStartWatchingSpecificFile,
  startWatchingById: vi.fn().mockResolvedValue(undefined),
  isWatching: mocks.codexIsWatching,
  preClaimFile: vi.fn(),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
  extractNewRolloutUuid: vi.fn(),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: mocks.geminiStartWatching,
  isWatching: mocks.geminiIsWatching,
  preClaimFile: vi.fn(),
}));

// We can't easily mock restartSession because it's in the same file as restoreFromStore
// and called internally. We provide valid data instead.

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdout: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }),
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));

import { restoreFromStore } from '../../src/agent/session-manager.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Session Restoration (all agents)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores Gemini watcher for live sessions', async () => {
    mocks.storeListSessions.mockReturnValue([
      {
        name: 'deck_proj_brain',
        agentType: 'gemini',
        projectDir: '/proj',
        geminiSessionId: 'gem-123',
        state: 'running',
        restartTimestamps: [],
      },
    ]);
    mocks.tmuxListSessions.mockResolvedValue(['deck_proj_brain']);

    await restoreFromStore();

    expect(mocks.geminiStartWatching).toHaveBeenCalledWith('deck_proj_brain', 'gem-123');
  });

  it('restores Codex watcher for live sessions', async () => {
    mocks.storeListSessions.mockReturnValue([
      {
        name: 'deck_proj_w1',
        agentType: 'codex',
        projectDir: '/proj',
        codexSessionId: 'cod-456',
        state: 'running',
        restartTimestamps: [],
      },
    ]);
    mocks.tmuxListSessions.mockResolvedValue(['deck_proj_w1']);

    await restoreFromStore();

    // It calls startCodexWatching because findRolloutPathByUuid returned null in mock
    expect(mocks.codexStartWatching).toHaveBeenCalledWith('deck_proj_w1', '/proj');
  });

  it('restarts missing sessions of any type', async () => {
    mocks.storeListSessions.mockReturnValue([
      {
        name: 'deck_missing_gemini',
        agentType: 'gemini',
        state: 'running',
        restartTimestamps: [],
        geminiSessionId: 'old-gem-id',
      },
      {
        name: 'deck_missing_claude',
        agentType: 'claude-code',
        state: 'running',
        restartTimestamps: [],
        ccSessionId: 'old-cc-id',
      },
    ]);
    mocks.tmuxListSessions.mockResolvedValue([]);

    await restoreFromStore();

    // Note: since we can't mock internal restartSession easily, 
    // it will call the real one which calls newSession.
    expect(mocks.newSession).toHaveBeenCalled();
  });

  it('skips restoration for stopped sessions', async () => {
    mocks.storeListSessions.mockReturnValue([
      {
        name: 'deck_stopped',
        agentType: 'claude-code',
        state: 'stopped',
        restartTimestamps: [],
      },
    ]);
    mocks.tmuxListSessions.mockResolvedValue(['deck_stopped']);

    await restoreFromStore();

    expect(mocks.jsonlStartWatching).not.toHaveBeenCalled();
  });
});
