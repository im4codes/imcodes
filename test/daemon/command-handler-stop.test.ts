import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stopProjectMock, stopSubSessionMock, loggerErrorMock, loggerWarnMock, buildSessionListMock, getTransportRuntimeMock } = vi.hoisted(() => ({
  stopProjectMock: vi.fn(),
  stopSubSessionMock: vi.fn().mockResolvedValue({ ok: true, closed: ['deck_sub_worker'], failed: [] }),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  buildSessionListMock: vi.fn(async () => []),
  getTransportRuntimeMock: vi.fn(() => undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: vi.fn(() => null),
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: stopProjectMock,
  teardownProject: vi.fn(),
  getTransportRuntime: getTransportRuntimeMock,
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    off: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: vi.fn(() => []),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: vi.fn(),
  stopSubSession: stopSubSessionMock,
  rebuildSubSessions: vi.fn(),
  detectShells: vi.fn().mockResolvedValue([]),
  readSubSessionResponse: vi.fn(),
  subSessionName: (id: string) => `deck_sub_${id}`,
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: vi.fn(),
  cancelP2pRun: vi.fn(),
  getP2pRun: vi.fn(() => undefined),
  listP2pRuns: vi.fn(() => []),
  serializeP2pRun: vi.fn(),
}));

vi.mock('../../src/daemon/session-list.js', () => ({
  buildSessionList: buildSessionListMock,
}));

vi.mock('../../src/daemon/repo-handler.js', () => ({
  handleRepoCommand: vi.fn(),
}));

vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  lookupAttachment: vi.fn(() => undefined),
}));

vi.mock('../../src/daemon/preview-relay.js', () => ({
  handlePreviewCommand: vi.fn(),
}));

vi.mock('../../src/daemon/provider-sessions.js', () => ({
  listProviderSessions: vi.fn(() => []),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: loggerWarnMock,
    error: loggerErrorMock,
    debug: vi.fn(),
  },
}));

vi.mock('../../src/util/imc-dir.js', () => ({
  ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'),
  imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`),
}));

// `buildSubSessionSync` (used by `subsession.rename`) probes Codex/Claude/Qwen
// runtime config to enrich the payload. The real probes hit local config
// files / spawn helpers and do many awaits, which can outlast `flushAsync()`.
// Stub them with sync resolved values so the rename test deterministically
// reaches the `serverLink.send` call within a single tick flush.
vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/agent/codex-display.js', () => ({
  mergeCodexDisplayMetadata: vi.fn(() => ({})),
}));
vi.mock('../../src/agent/sdk-runtime-config.js', () => ({
  getClaudeSdkRuntimeConfig: vi.fn().mockResolvedValue({}),
  normalizeClaudeSdkModelForProvider: vi.fn((m: unknown) => m),
}));
vi.mock('../../src/agent/provider-display.js', () => ({
  getQwenDisplayMetadata: vi.fn(() => ({})),
}));
vi.mock('../../src/agent/provider-quota.js', () => ({
  getQwenOAuthQuotaUsageLabel: vi.fn(() => undefined),
  recordQwenOAuthRequest: vi.fn(),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('handleWebCommand shutdown failure paths', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports structured session.stop failures without losing later command handling', async () => {
    stopProjectMock.mockResolvedValueOnce({
      ok: false,
      closed: [],
      failed: [{ sessionName: 'deck_proj_brain', stage: 'verify', message: 'session still exists after kill' }],
    });

    handleWebCommand({ type: 'session.stop', project: 'proj' }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'session.error',
      project: 'proj',
      message: 'Shutdown failed: deck_proj_brain:verify',
    });

    handleWebCommand({ type: 'subsession.stop', sessionName: 'deck_sub_worker' }, serverLink as any);
    await flushAsync();

    expect(stopSubSessionMock).toHaveBeenCalledWith('deck_sub_worker', serverLink);
  });

  it('reports thrown session.stop failures instead of only logging them', async () => {
    stopProjectMock.mockRejectedValueOnce(new Error('backend unavailable'));

    handleWebCommand({ type: 'session.stop', project: 'proj' }, serverLink as any);
    await flushAsync();

    expect(loggerErrorMock).toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'session.error',
      project: 'proj',
      message: 'Shutdown failed: backend unavailable',
    });
  });

  it('blocks daemon.upgrade when a transport session still has an active turn', async () => {
    const { listSessions } = await import('../../src/store/session-store.js');
    vi.mocked(listSessions).mockReturnValue([
      {
        name: 'deck_proj_brain',
        runtimeType: 'transport',
        state: 'running',
      } as any,
    ]);
    getTransportRuntimeMock.mockReturnValue({
      getStatus: () => 'thinking',
      sending: true,
      pendingCount: 0,
    } as any);

    handleWebCommand({ type: 'daemon.upgrade' }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'daemon.upgrade_blocked',
      reason: 'transport_busy',
      activeSessionNames: ['deck_proj_brain'],
    });
  });

  it('updates the main-session project name and pushes a refreshed session_list on session.rename', async () => {
    const { getSession, upsertSession } = await import('../../src/store/session-store.js');
    vi.mocked(getSession).mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      projectDir: '/tmp/proj',
    } as any);
    buildSessionListMock.mockResolvedValueOnce([
      {
        name: 'deck_proj_brain',
        project: 'new-proj',
        role: 'brain',
        agentType: 'codex',
        state: 'idle',
      },
    ]);

    handleWebCommand({ type: 'session.rename', sessionName: 'deck_proj_brain', projectName: 'new-proj' }, serverLink as any);
    await flushAsync();

    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_proj_brain',
      projectName: 'new-proj',
    }));
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'session_list',
      daemonVersion: '0.1.0',
      sessions: [
        {
          name: 'deck_proj_brain',
          project: 'new-proj',
          role: 'brain',
          agentType: 'codex',
          state: 'idle',
        },
      ],
    });
  });

  it('updates the main-session label and pushes a refreshed session_list on session.relabel', async () => {
    const { getSession, upsertSession } = await import('../../src/store/session-store.js');
    vi.mocked(getSession).mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
      label: null,
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      projectDir: '/tmp/proj',
    } as any);
    buildSessionListMock.mockResolvedValueOnce([
      {
        name: 'deck_proj_brain',
        project: 'proj',
        role: 'brain',
        agentType: 'codex',
        state: 'idle',
        label: 'Main Label',
      },
    ]);

    handleWebCommand({ type: 'session.relabel', sessionName: 'deck_proj_brain', label: 'Main Label' }, serverLink as any);
    await flushAsync();

    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_proj_brain',
      label: 'Main Label',
    }));
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'session_list',
      daemonVersion: '0.1.0',
      sessions: [
        {
          name: 'deck_proj_brain',
          project: 'proj',
          role: 'brain',
          agentType: 'codex',
          state: 'idle',
          label: 'Main Label',
        },
      ],
    });
  });

  it('clears the main-session label and pushes a refreshed session_list on session.relabel', async () => {
    const { getSession, upsertSession } = await import('../../src/store/session-store.js');
    vi.mocked(getSession).mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
      label: 'Main Label',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      projectDir: '/tmp/proj',
    } as any);
    buildSessionListMock.mockResolvedValueOnce([
      {
        name: 'deck_proj_brain',
        project: 'proj',
        role: 'brain',
        agentType: 'codex',
        state: 'idle',
      },
    ]);

    handleWebCommand({ type: 'session.relabel', sessionName: 'deck_proj_brain', label: null }, serverLink as any);
    await flushAsync();

    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_proj_brain',
      label: undefined,
    }));
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'session_list',
      daemonVersion: '0.1.0',
      sessions: [
        {
          name: 'deck_proj_brain',
          project: 'proj',
          role: 'brain',
          agentType: 'codex',
          state: 'idle',
        },
      ],
    });
  });

  it('updates the sub-session label and emits subsession.sync on subsession.rename', async () => {
    const { getSession, upsertSession } = await import('../../src/store/session-store.js');
    vi.mocked(getSession).mockReturnValue({
      name: 'deck_sub_worker',
      projectName: 'proj',
      role: 'w1',
      agentType: 'codex',
      state: 'idle',
      label: 'old',
      restarts: 0,
      restartTimestamps: [],
      createdAt: 1,
      updatedAt: 1,
      projectDir: '/tmp/proj',
      runtimeType: 'process',
      parentSession: 'deck_proj_brain',
    } as any);

    handleWebCommand({ type: 'subsession.rename', sessionName: 'deck_sub_worker', label: 'Worker Label' }, serverLink as any);
    await flushAsync();

    expect(upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_worker',
      label: 'Worker Label',
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'subsession.sync',
      id: 'worker',
      label: 'Worker Label',
    }));
  });
});
