/**
 * Regression test: restoreFromStore must skip deck_sub_* sessions.
 *
 * Bug: the restore loop iterated over ALL claude-code sessions in the store,
 * including sub-sessions. Sub-sessions have no ccSessionId in the store, so
 * startCCWatcher fell back to startWatching (directory scan), claiming the
 * main session's JSONL file and emitting its events under the sub-session name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── All mocks hoisted so factories can reference them ─────────────────────────

const {
  storeMock, tmuxListMock, startWatchingMock, startWatchingFileMock,
  isWatchingMock, restartSessionMock, getPaneStartCommandMock, upsertSessionMock, updateSessionStateMock,
  discoverLatestOpenCodeSessionIdMock, opencodeStartWatchingMock, opencodeIsWatchingMock,
  newSessionMock, timelineEmitMock,
} = vi.hoisted(() => ({
  storeMock: vi.fn(),
  tmuxListMock: vi.fn().mockResolvedValue(['deck_Cd_brain', 'deck_sub_5907196l']),
  startWatchingMock: vi.fn().mockResolvedValue(undefined),
  startWatchingFileMock: vi.fn().mockResolvedValue(undefined),
  isWatchingMock: vi.fn().mockReturnValue(false),
  restartSessionMock: vi.fn().mockResolvedValue(undefined),
  getPaneStartCommandMock: vi.fn().mockResolvedValue('claude --dangerously-skip-permissions'),
  upsertSessionMock: vi.fn(),
  updateSessionStateMock: vi.fn(),
  discoverLatestOpenCodeSessionIdMock: vi.fn().mockResolvedValue(undefined),
  opencodeStartWatchingMock: vi.fn().mockResolvedValue(undefined),
  opencodeIsWatchingMock: vi.fn().mockReturnValue(false),
  newSessionMock: vi.fn().mockResolvedValue(undefined),
  timelineEmitMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: storeMock,   // session-manager imports `listSessions as storeSessions`
  upsertSession: upsertSessionMock,
  updateSessionState: updateSessionStateMock,
  getSession: vi.fn(() => null),
  removeSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  listSessions: tmuxListMock,
  newSession: newSessionMock,
  killSession: vi.fn().mockResolvedValue(undefined),
  sessionExists: vi.fn().mockResolvedValue(true),
  isPaneAlive: vi.fn().mockResolvedValue(true),
  respawnPane: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue([]),
  sendKey: vi.fn(),
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  getPaneStartCommand: getPaneStartCommandMock,
  showBuffer: vi.fn().mockResolvedValue(''),
  cleanupOrphanFifos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: startWatchingMock,
  startWatchingFile: startWatchingFileMock,
  stopWatching: vi.fn(),
  isWatching: isWatchingMock,
  findJsonlPathBySessionId: (dir: string, id: string) => `/mock/${dir}/${id}.jsonl`,
  ensureClaudeSessionFile: vi.fn().mockResolvedValue(undefined),
  claudeProjectDir: (dir: string) => `/mock/${dir}`,
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  ensureSessionFile: vi.fn().mockResolvedValue('/mock/codex-rollout.jsonl'),
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn().mockReturnValue(false),
  extractNewRolloutUuid: vi.fn(),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/agent/detect.js', () => ({
  detectStatus: vi.fn(() => 'idle'),
  isTransportAgent: vi.fn(() => false),
}));

vi.mock('../../src/daemon/opencode-history.js', () => ({
  discoverLatestOpenCodeSessionId: discoverLatestOpenCodeSessionIdMock,
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: opencodeStartWatchingMock,
  stopWatching: vi.fn(),
  isWatching: opencodeIsWatchingMock,
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitMock, on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { read: vi.fn(() => []), append: vi.fn() },
}));

vi.mock('../../src/agent/brain-dispatcher.js', () => ({
  BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import { restoreFromStore, restartSession, respawnSession } from '../../src/agent/session-manager.js';
import { startWatching, startWatchingFile } from '../../src/daemon/jsonl-watcher.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('restoreFromStore — sub-session JSONL watcher regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmuxListMock.mockResolvedValue(['deck_Cd_brain', 'deck_sub_5907196l']);
    isWatchingMock.mockReturnValue(false);
    getPaneStartCommandMock.mockResolvedValue('claude --dangerously-skip-permissions');
    discoverLatestOpenCodeSessionIdMock.mockResolvedValue(undefined);
    opencodeStartWatchingMock.mockResolvedValue(undefined);
    opencodeIsWatchingMock.mockReturnValue(false);
    newSessionMock.mockResolvedValue(undefined);
  });

  it('does NOT call startWatching for deck_sub_* sessions (prevents JSONL file stealing)', async () => {
    storeMock.mockReturnValue([
      // Main brain session — has ccSessionId
      {
        name: 'deck_Cd_brain', agentType: 'claude-code',
        projectDir: '/proj', ccSessionId: 'main-uuid', state: 'running',
      },
      // Sub-session — no ccSessionId in store (the regression scenario)
      {
        name: 'deck_sub_5907196l', agentType: 'claude-code',
        projectDir: '/proj', ccSessionId: undefined, state: 'running',
      },
    ]);

    await restoreFromStore();

    // startWatchingFile should be called ONLY for the main session
    const fileWatchCalls = vi.mocked(startWatchingFile).mock.calls;
    const subSessionFileCalls = fileWatchCalls.filter(([session]) => session === 'deck_sub_5907196l');
    expect(subSessionFileCalls).toHaveLength(0);

    // startWatching (dir scan) must NEVER be called for deck_sub_* — it would steal files
    const dirWatchCalls = vi.mocked(startWatching).mock.calls;
    const subSessionDirCalls = dirWatchCalls.filter(([session]) => session === 'deck_sub_5907196l');
    expect(subSessionDirCalls).toHaveLength(0);
  });

  it('still starts startWatchingFile for the main brain session', async () => {
    storeMock.mockReturnValue([
      {
        name: 'deck_Cd_brain', agentType: 'claude-code',
        projectDir: '/proj', ccSessionId: 'main-uuid', state: 'running',
      },
      {
        name: 'deck_sub_5907196l', agentType: 'claude-code',
        projectDir: '/proj', ccSessionId: undefined, state: 'running',
      },
    ]);

    await restoreFromStore();

    const fileWatchCalls = vi.mocked(startWatchingFile).mock.calls;
    const mainCalls = fileWatchCalls.filter(([session]) => session === 'deck_Cd_brain');
    expect(mainCalls.length).toBeGreaterThan(0);
    expect(mainCalls[0][1]).toContain('main-uuid.jsonl');
  });

  it('backfills opencodeSessionId for live sub-sessions from tmux command', async () => {
    getPaneStartCommandMock.mockResolvedValueOnce('opencode -s oc-sub-restore-456');
    storeMock.mockReturnValue([
      {
        name: 'deck_sub_5907196l', agentType: 'opencode',
        projectDir: '/proj', opencodeSessionId: undefined, state: 'running',
      },
    ]);
    tmuxListMock.mockResolvedValue(['deck_sub_5907196l']);

    await restoreFromStore();

    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_5907196l',
      opencodeSessionId: 'oc-sub-restore-456',
    }));
    expect(opencodeStartWatchingMock).toHaveBeenCalledWith('deck_sub_5907196l', '/proj', 'oc-sub-restore-456');
  });

  it('backfills opencodeSessionId for live sub-sessions from sqlite history when tmux command has no -s', async () => {
    getPaneStartCommandMock.mockResolvedValueOnce('opencode');
    discoverLatestOpenCodeSessionIdMock.mockResolvedValueOnce('oc-sub-sqlite-789');
    storeMock.mockReturnValue([
      {
        name: 'deck_sub_5907196l', agentType: 'opencode',
        projectDir: '/proj', opencodeSessionId: undefined, state: 'running', createdAt: 2000,
      },
    ]);
    tmuxListMock.mockResolvedValue(['deck_sub_5907196l']);

    await restoreFromStore();

    expect(discoverLatestOpenCodeSessionIdMock).toHaveBeenCalledWith('/proj', expect.objectContaining({
      exactDirectory: '/proj',
      updatedAfter: 0,
      maxCount: 50,
    }));
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_5907196l',
      opencodeSessionId: 'oc-sub-sqlite-789',
    }));
  });

  it('emits a session-scoped error when restartSession hits loop protection', async () => {
    const now = Date.now();
    const result = await restartSession({
      name: 'deck_loop_brain',
      projectName: 'loop',
      role: 'brain',
      agentType: 'shell',
      projectDir: '/proj',
      state: 'running',
      restarts: 3,
      restartTimestamps: [now - 60_000, now - 120_000, now - 180_000],
      createdAt: now,
      updatedAt: now,
    });

    expect(result).toBe(false);
    expect(updateSessionStateMock).toHaveBeenCalledWith('deck_loop_brain', 'error');
    expect(timelineEmitMock).toHaveBeenCalledWith(
      'deck_loop_brain',
      'assistant.text',
      expect.objectContaining({
        text: '⚠️ Error: Restart loop detected: more than 3 restarts within 5 minutes',
        streaming: false,
      }),
      expect.any(Object),
    );
  });

  it('emits a session-scoped error when respawnSession hits loop protection', async () => {
    const now = Date.now();
    const result = await respawnSession({
      name: 'deck_loop_w1',
      projectName: 'loop',
      role: 'w1',
      agentType: 'shell',
      projectDir: '/proj',
      state: 'running',
      restarts: 3,
      restartTimestamps: [now - 60_000, now - 120_000, now - 180_000],
      createdAt: now,
      updatedAt: now,
    });

    expect(result).toBe(false);
    expect(updateSessionStateMock).toHaveBeenCalledWith('deck_loop_w1', 'error');
    expect(timelineEmitMock).toHaveBeenCalledWith(
      'deck_loop_w1',
      'assistant.text',
      expect.objectContaining({
        text: '⚠️ Error: Restart loop detected: more than 3 restarts within 5 minutes',
        streaming: false,
      }),
      expect.any(Object),
    );
  });
});
