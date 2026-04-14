import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, getTransportRuntimeMock, emitMock, relaunchSessionWithSettingsMock, stopTransportRuntimeSessionMock, resizeSessionMock, terminalSubscribeMock, terminalRequestSnapshotMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  emitMock: vi.fn(),
  relaunchSessionWithSettingsMock: vi.fn(),
  stopTransportRuntimeSessionMock: vi.fn().mockResolvedValue(undefined),
  resizeSessionMock: vi.fn(),
  terminalSubscribeMock: vi.fn(() => vi.fn()),
  terminalRequestSnapshotMock: vi.fn(),
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
  stopTransportRuntimeSession: stopTransportRuntimeSessionMock,
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: resizeSessionMock,
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: terminalSubscribeMock,
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestSnapshot: terminalRequestSnapshotMock,
    invalidateSize: vi.fn(),
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
      providerSessionId: 'route-transport',
      send: vi.fn(() => 'queued'),
      pendingCount: 2,
      pendingMessages: ['queued msg', 'queued msg 2'],
      pendingEntries: [
        { clientMessageId: 'cmd-queued', text: 'queued msg' },
        { clientMessageId: 'cmd-queued-2', text: 'queued msg 2' },
      ],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'queued msg', commandId: 'cmd-queued' }, serverLink as any);
    await flushAsync();

    expect(emitMock).not.toHaveBeenCalledWith('deck_transport_brain', 'user.message', { text: 'queued msg' });
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      {
        state: 'queued',
        pendingCount: 2,
        pendingMessages: ['queued msg', 'queued msg 2'],
        pendingMessageEntries: [
          { clientMessageId: 'cmd-queued', text: 'queued msg' },
          { clientMessageId: 'cmd-queued-2', text: 'queued msg 2' },
        ],
      },
      expect.any(Object),
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-queued', status: 'accepted' });
  });

  it('dispatches /stop immediately for transport sessions without emitting queued state', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      cancel,
      send: vi.fn(() => 'queued'),
      pendingCount: 3,
      pendingMessages: ['a', 'b', 'c'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/stop', commandId: 'cmd-stop' }, serverLink as any);
    await flushAsync();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'user.message', { text: '/stop', allowDuplicate: true });
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-stop', status: 'accepted' });
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({ state: 'queued' }),
      expect.anything(),
    );
  });

  it('emits a user.message immediately for dispatched transport sends', async () => {
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
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

  it('passes the raw user message to transport runtime assembly without client-side context shaping', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'review the latest patch',
      commandId: 'cmd-parity',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledTimes(1);
    expect(transportSend).toHaveBeenCalledWith('review the latest patch', 'cmd-parity');
    expect(typeof transportSend.mock.calls[0][0]).toBe('string');
  });

  it('does not short-circuit transport identity questions in the daemon', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '你在用什么模型',
      commandId: 'cmd-identity',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('你在用什么模型', 'cmd-identity');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'user.message', { text: '你在用什么模型', allowDuplicate: true });
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({ text: expect.any(String), streaming: false }),
      expect.anything(),
    );
  });

  it('treats transport runtimes without a provider session id as unavailable', async () => {
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: null,
      send: vi.fn(() => {
        throw new Error('TransportSessionRuntime not initialized — call initialize() first');
      }),
      pendingCount: 0,
      pendingMessages: [],
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'hello after restart',
      commandId: 'cmd-stale-runtime',
    }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      { text: '⚠️ Provider unknown restarting. Please resend in a moment.', streaming: false },
      expect.any(Object),
    );
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-stale-runtime',
      status: 'error',
      session: 'deck_transport_brain',
      error: 'Provider unknown restarting. Please resend in a moment.',
    });
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
      restartResolved ? { providerSessionId: 'route-transport', send: transportSend, pendingCount: 0 } : undefined
    ));

    handleWebCommand({ type: 'session.restart', sessionName: 'deck_transport_brain', agentType: 'claude-code-sdk' }, serverLink as any);
    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'after restart', commandId: 'cmd-after-restart' }, serverLink as any);

    await flushAsync();
    expect(transportSend).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-after-restart', status: 'accepted' });

    resolveRestart?.();
    await flushAsync();
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('after restart', 'cmd-after-restart');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'user.message', { text: 'after restart', allowDuplicate: true });
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-after-restart', status: 'accepted' });
  });

  it('deduplicates concurrent session.restart requests for the same transport session', async () => {
    let resolveRestart: (() => void) | null = null;
    relaunchSessionWithSettingsMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRestart = resolve;
      }),
    );

    handleWebCommand({ type: 'session.restart', sessionName: 'deck_transport_brain', agentType: 'claude-code-sdk' }, serverLink as any);
    handleWebCommand({ type: 'session.restart', sessionName: 'deck_transport_brain', agentType: 'claude-code-sdk' }, serverLink as any);

    await flushAsync();
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);

    resolveRestart?.();
    await flushAsync();
    await flushAsync();
  });

  it('skips terminal subscribe and snapshot requests for transport sessions', async () => {
    handleWebCommand({ type: 'terminal.subscribe', session: 'deck_transport_brain' }, serverLink as any);
    handleWebCommand({ type: 'terminal.snapshot_request', sessionName: 'deck_transport_brain' }, serverLink as any);
    await flushAsync();

    expect(terminalSubscribeMock).not.toHaveBeenCalled();
    expect(terminalRequestSnapshotMock).not.toHaveBeenCalled();
  });

  it('skips tmux resize for transport sessions', async () => {
    handleWebCommand({ type: 'session.resize', sessionName: 'deck_transport_brain', cols: 200, rows: 50 }, serverLink as any);
    await flushAsync();

    expect(resizeSessionMock).not.toHaveBeenCalled();
  });
});
