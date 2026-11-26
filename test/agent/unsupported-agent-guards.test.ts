import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const {
  storeMock,
  tmuxListMock,
  killSessionMock,
  upsertSessionMock,
  updateSessionStateMock,
  getSessionMock,
  respawnPaneMock,
  newSessionMock,
  stopWatchingMock,
  stopCodexWatchingMock,
  stopOpenCodeWatchingMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  storeMock: vi.fn<() => SessionRecord[]>(() => []),
  tmuxListMock: vi.fn<() => Promise<string[]>>().mockResolvedValue([]),
  killSessionMock: vi.fn().mockResolvedValue(undefined),
  upsertSessionMock: vi.fn(),
  updateSessionStateMock: vi.fn(),
  getSessionMock: vi.fn(() => null),
  respawnPaneMock: vi.fn().mockResolvedValue(undefined),
  newSessionMock: vi.fn().mockResolvedValue(undefined),
  stopWatchingMock: vi.fn(),
  stopCodexWatchingMock: vi.fn(),
  stopOpenCodeWatchingMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: (project?: string) => {
    const all = storeMock();
    return project ? all.filter((s) => s.projectName === project) : all;
  },
  upsertSession: upsertSessionMock,
  updateSessionState: updateSessionStateMock,
  getSession: getSessionMock,
  removeSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  listSessions: tmuxListMock,
  newSession: newSessionMock,
  killSession: killSessionMock,
  sessionExists: vi.fn().mockResolvedValue(false),
  isPaneAlive: vi.fn().mockResolvedValue(true),
  respawnPane: respawnPaneMock,
  capturePane: vi.fn().mockResolvedValue([]),
  sendKey: vi.fn(),
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  getPaneStartCommand: vi.fn().mockResolvedValue(''),
  showBuffer: vi.fn().mockResolvedValue(''),
  cleanupOrphanFifos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  reserveSessionFile: vi.fn(),
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: stopWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
  findJsonlPathBySessionId: vi.fn(() => '/tmp/mock.jsonl'),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  ensureSessionFile: vi.fn().mockResolvedValue(undefined),
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  startWatchingById: vi.fn().mockResolvedValue(undefined),
  stopWatching: stopCodexWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
  extractNewRolloutUuid: vi.fn(),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  stopWatching: stopOpenCodeWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { read: vi.fn(() => []), append: vi.fn() },
}));

vi.mock('../../src/agent/provider-registry.js', () => ({
  getProvider: vi.fn(() => null),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  launchSession,
  restartSession,
  respawnSession,
  restoreFromStore,
  teardownProject,
} from '../../src/agent/session-manager.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_cd_w1',
    projectName: 'cd',
    role: 'w1',
    agentType: 'gemini-sdk' as SessionRecord['agentType'],
    projectDir: '/proj/cd',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('unsupported/removed agentType & sub-session guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmuxListMock.mockResolvedValue([]);
    storeMock.mockReturnValue([]);
  });

  it('teardownProject only tears down main/worker project sessions and leaves sub-sessions untouched', async () => {
    storeMock.mockReturnValue([
      makeRecord({ name: 'deck_cd_brain', role: 'brain', agentType: 'codex-sdk' }),
      makeRecord({ name: 'deck_cd_w1', role: 'w1', agentType: 'codex' }),
      makeRecord({
        name: 'deck_sub_sup_auto_cf1b33349f12b0e5',
        role: 'w1',
        agentType: 'gemini-sdk' as SessionRecord['agentType'],
        parentSession: 'deck_cd_brain',
      }),
      makeRecord({ name: 'deck_other_brain', projectName: 'other', role: 'brain', agentType: 'claude-code' }),
    ]);

    await teardownProject('cd');

    expect(killSessionMock).toHaveBeenCalledTimes(2);
    expect(killSessionMock).toHaveBeenCalledWith('deck_cd_brain');
    expect(killSessionMock).toHaveBeenCalledWith('deck_cd_w1');
    expect(killSessionMock).not.toHaveBeenCalledWith('deck_sub_sup_auto_cf1b33349f12b0e5');
    expect(stopWatchingMock).not.toHaveBeenCalledWith('deck_sub_sup_auto_cf1b33349f12b0e5');
  });

  it('launchSession rejects removed agent types before touching getDriver', async () => {
    await expect(launchSession({
      name: 'deck_cd_w1',
      projectName: 'cd',
      role: 'w1',
      agentType: 'gemini-sdk' as never,
      projectDir: '/proj/cd',
    })).rejects.toThrow("Unsupported or removed agent type 'gemini-sdk'");

    await expect(launchSession({
      name: 'deck_cd_w2',
      projectName: 'cd',
      role: 'w2',
      agentType: 'gemini' as never,
      projectDir: '/proj/cd',
    })).rejects.toThrow("Unsupported or removed agent type 'gemini'");

    expect(newSessionMock).not.toHaveBeenCalled();
  });

  it('restartSession and respawnSession gracefully skip removed agent types and mark stopped', async () => {
    const legacyProcess = makeRecord({ name: 'deck_cd_w1', agentType: 'gemini' as SessionRecord['agentType'] });
    const legacySdkNoRuntime = makeRecord({ name: 'deck_cd_w2', agentType: 'gemini-sdk' as SessionRecord['agentType'] });

    await expect(restartSession(legacyProcess)).resolves.toBe(false);
    await expect(restartSession(legacySdkNoRuntime)).resolves.toBe(false);
    await expect(respawnSession(legacyProcess)).resolves.toBe(false);
    await expect(respawnSession(legacySdkNoRuntime)).resolves.toBe(false);

    expect(updateSessionStateMock).toHaveBeenCalledWith('deck_cd_w1', 'stopped');
    expect(updateSessionStateMock).toHaveBeenCalledWith('deck_cd_w2', 'stopped');
    expect(newSessionMock).not.toHaveBeenCalled();
    expect(respawnPaneMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  it('restoreFromStore skips persisted gemini and gemini-sdk records cleanly without throwing', async () => {
    storeMock.mockReturnValue([
      makeRecord({ name: 'deck_cd_w1', agentType: 'gemini' as SessionRecord['agentType'] }),
      makeRecord({
        name: 'deck_sub_sup_auto_cf1b33349f12b0e5',
        agentType: 'gemini-sdk' as SessionRecord['agentType'],
        runtimeType: 'transport',
        parentSession: 'deck_cd_brain',
      }),
    ]);

    await expect(restoreFromStore()).resolves.toBeUndefined();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { session: 'deck_cd_w1', agentType: 'gemini' },
      'restoreFromStore: skipping unsupported or removed agent type',
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { session: 'deck_sub_sup_auto_cf1b33349f12b0e5', agentType: 'gemini-sdk' },
      'restoreFromStore: skipping unsupported or removed agent type',
    );
    expect(newSessionMock).not.toHaveBeenCalled();
  });
});
