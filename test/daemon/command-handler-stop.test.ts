import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stopProjectMock, stopSubSessionMock, loggerErrorMock, loggerWarnMock } = vi.hoisted(() => ({
  stopProjectMock: vi.fn(),
  stopSubSessionMock: vi.fn().mockResolvedValue({ ok: true, closed: ['deck_sub_worker'], failed: [] }),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
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
  getTransportRuntime: vi.fn(() => undefined),
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
});
