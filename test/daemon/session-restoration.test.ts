import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  storeListSessions: vi.fn(),
  storeUpsertSession: vi.fn(),
  tmuxListSessions: vi.fn(),
  getPaneStartCommand: vi.fn().mockResolvedValue('claude --dangerously-skip-permissions'),
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
  respawnPane: vi.fn().mockResolvedValue(undefined),
  discoverLatestOpenCodeSessionId: vi.fn().mockResolvedValue(undefined),
  openCodeStartWatching: vi.fn().mockResolvedValue(undefined),
  openCodeIsWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: mocks.storeListSessions,
  upsertSession: mocks.storeUpsertSession,
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
  isPaneAlive: vi.fn().mockResolvedValue(true),
  respawnPane: mocks.respawnPane,
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  getPaneStartCommand: mocks.getPaneStartCommand,
  cleanupOrphanFifos: vi.fn(),
  newSession: mocks.newSession,
  capturePane: vi.fn().mockResolvedValue([]),
  sendKey: vi.fn(),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: mocks.jsonlStartWatching,
  startWatchingFile: mocks.jsonlStartWatchingFile,
  isWatching: mocks.jsonlIsWatching,
  preClaimFile: vi.fn(),
  findJsonlPathBySessionId: (d: string, id: string) => `/mock/${d}/${id}.jsonl`,
  ensureClaudeSessionFile: vi.fn().mockResolvedValue(undefined),
  claudeProjectDir: (d: string) => `/mock/${d}`,
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  ensureSessionFile: vi.fn().mockResolvedValue('/mock/codex-rollout.jsonl'),
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
  exec: vi.fn((_cmd: string, _opts: unknown, cb?: Function) => {
    if (cb) cb(null, { stdout: '', stderr: '' });
    return { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
  }),
  execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb?: Function) => {
    if (cb) cb(null, { stdout: '', stderr: '' });
  }),
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

vi.mock('../../src/daemon/opencode-history.js', () => ({
  discoverLatestOpenCodeSessionId: mocks.discoverLatestOpenCodeSessionId,
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: mocks.openCodeStartWatching,
  stopWatching: vi.fn(),
  isWatching: mocks.openCodeIsWatching,
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

  it('skips respawn for live Claude sessions with no recoverable ccSessionId (does not interrupt running task)', async () => {
    mocks.storeListSessions.mockReturnValue([
      {
        name: 'deck_proj_brain',
        agentType: 'claude-code',
        projectDir: '/proj',
        state: 'running',
        restartTimestamps: [],
      },
    ]);
    mocks.tmuxListSessions.mockResolvedValue(['deck_proj_brain']);

    await restoreFromStore();

    // Should NOT respawn — session is alive, just missing ccSessionId
    expect(mocks.respawnPane).not.toHaveBeenCalled();
    expect(mocks.jsonlStartWatching).not.toHaveBeenCalled();
  });

  it('backfills opencodeSessionId for live main OpenCode sessions from tmux command', async () => {
    mocks.getPaneStartCommand.mockResolvedValueOnce('opencode -s "oc-main-restore-123"');
    mocks.storeListSessions.mockReturnValue([
      {
        name: 'deck_proj_brain',
        agentType: 'opencode',
        projectDir: '/proj',
        state: 'running',
        restartTimestamps: [],
      },
    ]);
    mocks.tmuxListSessions.mockResolvedValue(['deck_proj_brain']);

    await restoreFromStore();

    expect(mocks.storeUpsertSession).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_proj_brain',
      opencodeSessionId: 'oc-main-restore-123',
    }));
    expect(mocks.openCodeStartWatching).toHaveBeenCalledWith('deck_proj_brain', '/proj', 'oc-main-restore-123');
  });

  it('backfills opencodeSessionId for live main OpenCode sessions from sqlite history when tmux command has no -s', async () => {
    mocks.getPaneStartCommand.mockResolvedValueOnce('opencode');
    mocks.discoverLatestOpenCodeSessionId.mockResolvedValueOnce('oc-main-sqlite-123');
    mocks.storeListSessions.mockReturnValue([
      {
        name: 'deck_proj_brain',
        agentType: 'opencode',
        projectDir: '/proj',
        state: 'running',
        createdAt: 1000,
        restartTimestamps: [],
      },
    ]);
    mocks.tmuxListSessions.mockResolvedValue(['deck_proj_brain']);

    await restoreFromStore();

    expect(mocks.discoverLatestOpenCodeSessionId).toHaveBeenCalledWith('/proj', expect.objectContaining({
      exactDirectory: '/proj',
      updatedAfter: 0,
      maxCount: 50,
    }));
    expect(mocks.storeUpsertSession).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_proj_brain',
      opencodeSessionId: 'oc-main-sqlite-123',
    }));
  });
});
