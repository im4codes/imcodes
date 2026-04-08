import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, getTransportRuntimeMock, emitMock, relaunchSessionWithSettingsMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  emitMock: vi.fn(),
  relaunchSessionWithSettingsMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: getTransportRuntimeMock,
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: relaunchSessionWithSettingsMock,
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
    emit: emitMock,
    on: vi.fn(() => () => {}),
    off: vi.fn(),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
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
  stopSubSession: vi.fn(),
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
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/util/imc-dir.js', () => ({
  ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'),
  imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('handleWebCommand transport queue behavior', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
    });
  });

  it('does not emit a user.message for queued transport sends', async () => {
    getTransportRuntimeMock.mockReturnValue({
      send: vi.fn(() => 'queued'),
      pendingCount: 2,
      pendingMessages: ['queued msg', 'queued msg 2'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'queued msg', commandId: 'cmd-queued' }, serverLink as any);
    await flushAsync();

    expect(emitMock).not.toHaveBeenCalledWith('deck_transport_brain', 'user.message', { text: 'queued msg' });
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      { state: 'queued', pendingCount: 2, pendingMessages: ['queued msg', 'queued msg 2'] },
      expect.any(Object),
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-queued', status: 'accepted' });
  });

  it('emits a user.message immediately for dispatched transport sends', async () => {
    getTransportRuntimeMock.mockReturnValue({
      send: vi.fn(() => 'sent'),
      pendingCount: 0,
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'sent msg', commandId: 'cmd-sent' }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'user.message', { text: 'sent msg', allowDuplicate: true });
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({ state: 'queued' }),
      expect.anything(),
    );
  });

  it('waits for an in-flight settings restart before sending the first transport message', async () => {
    let restartResolved = false;
    let resolveRestart: (() => void) | null = null;
    relaunchSessionWithSettingsMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRestart = () => {
          restartResolved = true;
          resolve();
        };
      }),
    );
    getSessionMock.mockImplementation(() => ({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: restartResolved ? 'claude-code-sdk' : 'claude-code',
      runtimeType: restartResolved ? 'transport' : 'process',
      state: 'idle',
    }));
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockImplementation(() => (
      restartResolved ? { send: transportSend, pendingCount: 0 } : undefined
    ));

    handleWebCommand({ type: 'session.restart', sessionName: 'deck_transport_brain', agentType: 'claude-code-sdk' }, serverLink as any);
    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'after restart', commandId: 'cmd-after-restart' }, serverLink as any);

    await flushAsync();
    expect(transportSend).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-after-restart', status: 'accepted' });

    resolveRestart?.();
    await flushAsync();
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('after restart');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'user.message', { text: 'after restart', allowDuplicate: true });
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-after-restart', status: 'accepted' });
  });
});
