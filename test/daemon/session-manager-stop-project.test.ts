import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  storeMock,
  killSessionMock,
  sessionExistsMock,
  removeSessionMock,
  upsertSessionMock,
  stopWatchingMock,
  stopCodexWatchingMock,
  stopGeminiWatchingMock,
  stopOpenCodeWatchingMock,
  repoInvalidateMock,
  timelineEmitMock,
  serverSendMock,
} = vi.hoisted(() => ({
  storeMock: vi.fn(),
  killSessionMock: vi.fn().mockResolvedValue(undefined),
  sessionExistsMock: vi.fn().mockResolvedValue(false),
  removeSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  stopWatchingMock: vi.fn(),
  stopCodexWatchingMock: vi.fn(),
  stopGeminiWatchingMock: vi.fn(),
  stopOpenCodeWatchingMock: vi.fn(),
  repoInvalidateMock: vi.fn(),
  timelineEmitMock: vi.fn(),
  serverSendMock: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  killSession: killSessionMock,
  sessionExists: sessionExistsMock,
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
  upsertSession: upsertSessionMock,
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

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  stopWatching: stopOpenCodeWatchingMock,
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/repo/cache.js', () => ({
  repoCache: { invalidate: repoInvalidateMock },
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
  timelineEmitter: { emit: timelineEmitMock, on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
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
    sessionExistsMock.mockResolvedValue(false);
    serverSendMock.mockImplementation(() => undefined);
  });

  it('stops project sessions and nested sub-sessions recursively', async () => {
    storeMock.mockReturnValue([
      { name: 'deck_recon_brain', projectName: 'recon', projectDir: '/proj', role: 'brain', agentType: 'claude-code', state: 'running', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      { name: 'deck_recon_w10', projectName: 'recon', projectDir: '/proj', role: 'w10', agentType: 'codex', state: 'idle', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      { name: 'deck_sub_root', projectName: 'deck_sub_root', projectDir: '/proj', role: 'w1', agentType: 'claude-code', state: 'running', parentSession: 'deck_recon_w10', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      { name: 'deck_sub_nested', projectName: 'deck_sub_nested', projectDir: '/proj', role: 'w1', agentType: 'claude-code', state: 'running', parentSession: 'deck_sub_root', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      { name: 'deck_other_brain', projectName: 'other', projectDir: '/other', role: 'brain', agentType: 'claude-code', state: 'running', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      { name: 'deck_sub_other', projectName: 'deck_sub_other', projectDir: '/other', role: 'w1', agentType: 'claude-code', state: 'running', parentSession: 'deck_other_brain', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
    ]);

    const result = await stopProject('recon', { send: serverSendMock });

    expect(result).toEqual({
      ok: true,
      closed: ['deck_sub_nested', 'deck_sub_root', 'deck_recon_brain', 'deck_recon_w10'],
      failed: [],
    });

    expect(killSessionMock.mock.calls.map((call) => call[0])).toEqual([
      'deck_sub_nested',
      'deck_sub_root',
      'deck_recon_brain',
      'deck_recon_w10',
    ]);
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

    expect(serverSendMock).toHaveBeenCalledWith({ type: 'subsession.closed', id: 'nested', sessionName: 'deck_sub_nested' });
    expect(serverSendMock).toHaveBeenCalledWith({ type: 'subsession.closed', id: 'root', sessionName: 'deck_sub_root' });
    expect(repoInvalidateMock).toHaveBeenCalledTimes(1);
  });

  it('retains failed descendants for retry and does not emit false-success close events', async () => {
    storeMock.mockReturnValue([
      { name: 'deck_recon_brain', projectName: 'recon', projectDir: '/proj', role: 'brain', agentType: 'claude-code', state: 'running', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      { name: 'deck_sub_root', projectName: 'deck_sub_root', projectDir: '/proj', role: 'w1', agentType: 'claude-code', state: 'running', parentSession: 'deck_recon_brain', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
    ]);
    sessionExistsMock.mockImplementation(async (sessionName: string) => sessionName === 'deck_sub_root');

    const result = await stopProject('recon', { send: serverSendMock });

    expect(result.ok).toBe(false);
    expect(result.closed).toEqual(['deck_recon_brain']);
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionName: 'deck_sub_root', stage: 'verify' }),
      ]),
    );
    expect(removeSessionMock).not.toHaveBeenCalledWith('deck_sub_root');
    expect(removeSessionMock).toHaveBeenCalledWith('deck_recon_brain');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_root',
      state: 'error',
      parentSession: 'deck_recon_brain',
    }));
    expect(serverSendMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.closed',
      sessionName: 'deck_sub_root',
    }));
    expect(timelineEmitMock).not.toHaveBeenCalledWith('deck_sub_root', 'session.state', { state: 'stopped' });
    expect(serverSendMock).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.closed',
      id: 'root',
    }));
  });

  it('does not emit stopped or remove a descendant when subsession.closed persistence fails', async () => {
    storeMock.mockReturnValue([
      { name: 'deck_recon_brain', projectName: 'recon', projectDir: '/proj', role: 'brain', agentType: 'claude-code', state: 'running', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      { name: 'deck_sub_root', projectName: 'deck_sub_root', projectDir: '/proj', role: 'w1', agentType: 'claude-code', state: 'running', parentSession: 'deck_recon_brain', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
    ]);
    serverSendMock.mockImplementation((msg: { type?: string; sessionName?: string }) => {
      if (msg.type === 'subsession.closed' && msg.sessionName === 'deck_sub_root') {
        throw new Error('bridge offline');
      }
    });

    const result = await stopProject('recon', { send: serverSendMock });

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionName: 'deck_sub_root', stage: 'persist', message: 'bridge offline' }),
      ]),
    );
    expect(removeSessionMock).not.toHaveBeenCalledWith('deck_sub_root');
    expect(timelineEmitMock).not.toHaveBeenCalledWith('deck_sub_root', 'session.state', { state: 'stopped' });
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_root',
      state: 'error',
    }));
  });

  it('retains failed descendants for a later retry that can complete successfully', async () => {
    storeMock
      .mockReturnValueOnce([
        { name: 'deck_recon_brain', projectName: 'recon', projectDir: '/proj', role: 'brain', agentType: 'claude-code', state: 'running', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
        { name: 'deck_sub_root', projectName: 'deck_sub_root', projectDir: '/proj', role: 'w1', agentType: 'claude-code', state: 'running', parentSession: 'deck_recon_brain', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
      ])
      .mockReturnValueOnce([
        { name: 'deck_recon_brain', projectName: 'recon', projectDir: '/proj', role: 'brain', agentType: 'claude-code', state: 'running', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1 },
        { name: 'deck_sub_root', projectName: 'deck_sub_root', projectDir: '/proj', role: 'w1', agentType: 'claude-code', state: 'error', parentSession: 'deck_recon_brain', restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2 },
      ]);
    sessionExistsMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);

    const first = await stopProject('recon', { send: serverSendMock });
    const second = await stopProject('recon', { send: serverSendMock });

    expect(first.ok).toBe(false);
    expect(first.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionName: 'deck_sub_root', stage: 'verify' }),
      ]),
    );
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_root',
      state: 'error',
    }));

    expect(second).toEqual({
      ok: true,
      closed: ['deck_sub_root', 'deck_recon_brain'],
      failed: [],
    });
    expect(removeSessionMock).toHaveBeenCalledWith('deck_sub_root');
    expect(serverSendMock).toHaveBeenCalledWith({ type: 'subsession.closed', id: 'root', sessionName: 'deck_sub_root' });
  });
});
