import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  storeMock,
  killSessionMock,
  removeSessionMock,
  stopWatchingMock,
  stopCodexWatchingMock,
  stopGeminiWatchingMock,
} = vi.hoisted(() => ({
  storeMock: vi.fn(),
  killSessionMock: vi.fn().mockResolvedValue(undefined),
  removeSessionMock: vi.fn(),
  stopWatchingMock: vi.fn(),
  stopCodexWatchingMock: vi.fn(),
  stopGeminiWatchingMock: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  killSession: killSessionMock,
  sessionExists: vi.fn().mockResolvedValue(false),
  isPaneAlive: vi.fn().mockResolvedValue(true),
  respawnPane: vi.fn().mockResolvedValue(undefined),
  listSessions: vi.fn().mockResolvedValue([]),
  sendKeys: vi.fn(),
  sendKey: vi.fn(),
  capturePane: vi.fn().mockResolvedValue([]),
  showBuffer: vi.fn().mockResolvedValue(''),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  getPaneCwd: vi.fn().mockResolvedValue('/proj'),
  getPaneStartCommand: vi.fn().mockResolvedValue(''),
  cleanupOrphanFifos: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(() => null),
  upsertSession: vi.fn(),
  removeSession: removeSessionMock,
  listSessions: storeMock,
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: stopWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
  findJsonlPathBySessionId: vi.fn(() => '/tmp/mock.jsonl'),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingSpecificFile: vi.fn().mockResolvedValue(undefined),
  startWatchingById: vi.fn().mockResolvedValue(undefined),
  stopWatching: stopCodexWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
  findRolloutPathByUuid: vi.fn().mockResolvedValue(null),
  extractNewRolloutUuid: vi.fn(),
  ensureSessionFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/daemon/gemini-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingLatest: vi.fn().mockResolvedValue(undefined),
  stopWatching: stopGeminiWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/repo/cache.js', () => ({
  repoCache: { invalidate: vi.fn() },
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn(),
}));

vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn(),
  setupOpenCodePlugin: vi.fn(),
}));

vi.mock('../../src/agent/provider-registry.js', () => ({
  getProvider: vi.fn(() => null),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));

vi.mock('../../src/agent/transport-session-runtime.js', () => ({
  TransportSessionRuntime: vi.fn(),
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: vi.fn().mockResolvedValue('test'),
}));

vi.mock('../../src/agent/detect.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/agent/detect.js')>('../../src/agent/detect.js');
  return { ...actual, isTransportAgent: vi.fn(() => false) };
});

import { stopProject } from '../../src/agent/session-manager.js';

describe('stopProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stops project sessions and nested sub-sessions recursively', async () => {
    storeMock.mockReturnValue([
      { name: 'deck_recon_brain', projectName: 'recon', projectDir: '/proj', state: 'running' },
      { name: 'deck_recon_w10', projectName: 'recon', projectDir: '/proj', state: 'idle' },
      { name: 'deck_sub_root', projectName: 'deck_sub_root', projectDir: '/proj', state: 'running', parentSession: 'deck_recon_w10' },
      { name: 'deck_sub_nested', projectName: 'deck_sub_nested', projectDir: '/proj', state: 'running', parentSession: 'deck_sub_root' },
      { name: 'deck_other_brain', projectName: 'other', projectDir: '/other', state: 'running' },
      { name: 'deck_sub_other', projectName: 'deck_sub_other', projectDir: '/other', state: 'running', parentSession: 'deck_other_brain' },
    ]);

    await stopProject('recon');

    expect(killSessionMock).toHaveBeenCalledWith('deck_recon_brain');
    expect(killSessionMock).toHaveBeenCalledWith('deck_recon_w10');
    expect(killSessionMock).toHaveBeenCalledWith('deck_sub_root');
    expect(killSessionMock).toHaveBeenCalledWith('deck_sub_nested');
    expect(killSessionMock).not.toHaveBeenCalledWith('deck_other_brain');
    expect(killSessionMock).not.toHaveBeenCalledWith('deck_sub_other');

    expect(removeSessionMock).toHaveBeenCalledWith('deck_recon_brain');
    expect(removeSessionMock).toHaveBeenCalledWith('deck_recon_w10');
    expect(removeSessionMock).toHaveBeenCalledWith('deck_sub_root');
    expect(removeSessionMock).toHaveBeenCalledWith('deck_sub_nested');
    expect(removeSessionMock).not.toHaveBeenCalledWith('deck_other_brain');
    expect(removeSessionMock).not.toHaveBeenCalledWith('deck_sub_other');
  });
});
