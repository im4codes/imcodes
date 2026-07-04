import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  dispatchDelegatedSessionSendMock,
  getSessionMock,
  timelineEmitMock,
  outboxEnqueueMock,
  outboxMarkAckedMock,
} = vi.hoisted(() => ({
  dispatchDelegatedSessionSendMock: vi.fn(),
  getSessionMock: vi.fn(),
  timelineEmitMock: vi.fn(),
  outboxEnqueueMock: vi.fn(async () => undefined),
  outboxMarkAckedMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/daemon/session-dispatch.js', () => ({
  dispatchDelegatedSessionSend: dispatchDelegatedSessionSendMock,
}));

vi.mock('../../src/daemon/ack-outbox.js', () => ({
  getDefaultAckOutbox: () => ({
    enqueue: outboxEnqueueMock,
    markAcked: outboxMarkAckedMock,
  }),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn(), requestSnapshot: vi.fn(), invalidateSize: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: timelineEmitMock, on: vi.fn(() => () => {}), off: vi.fn(), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn() } }));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));
vi.mock('../../src/daemon/git-remote-clone.js', () => ({ maybeCloneGitRemoteToDirectory: vi.fn(async ({ targetDir }: { targetDir: string }) => targetDir) }));

const { handleWebCommand } = await import('../../src/daemon/command-handler.js');

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function serverLink() {
  return {
    send: vi.fn(),
    trySend: vi.fn(() => true),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };
}

describe('command-handler delegation routing behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      projectDir: '/repo',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
    });
    dispatchDelegatedSessionSendMock.mockResolvedValue({
      status: 'accepted',
      target: 'deck_proj_w1',
      contextStatus: 'ok',
      dispatchId: 'snd_dispatch_test',
      messageId: 'snd_msg_test',
    });
  });

  it('dispatches valid delegation once and emits delegated ack metadata through timeline and reliable ack', async () => {
    const link = serverLink();
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'do the task',
      commandId: 'delegate-ok-1',
      delegateTarget: { session: 'deck_proj_w1' },
    }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).toHaveBeenCalledTimes(1);
    expect(dispatchDelegatedSessionSendMock.mock.calls[0][0]).toMatchObject({
      targetSession: 'deck_proj_w1',
      message: 'do the task',
      caller: {
        sessionName: 'deck_proj_brain',
        projectName: 'proj',
        projectRoot: '/repo',
      },
    });
    expect(timelineEmitMock).toHaveBeenCalledWith('deck_proj_brain', 'command.ack', expect.objectContaining({
      commandId: 'delegate-ok-1',
      status: 'accepted',
      delegated: true,
      targetSession: 'deck_proj_w1',
      delegationContextStatus: 'ok',
    }));
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command.ack',
      commandId: 'delegate-ok-1',
      status: 'accepted',
      delegated: true,
      targetSession: 'deck_proj_w1',
      delegationContextStatus: 'ok',
    }));
    expect(outboxEnqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-ok-1',
      extras: expect.objectContaining({
        delegated: true,
        targetSession: 'deck_proj_w1',
        delegationContextStatus: 'ok',
      }),
    }));
  });

  it('replays the delegated terminal ack for bridge retry without dispatching again', async () => {
    const link = serverLink();
    const cmd = {
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'retry-safe task',
      commandId: 'delegate-ok-retry-1',
      delegateTarget: { session: 'deck_proj_w1' },
    };
    handleWebCommand(cmd, link as any);
    await flushAsync();
    handleWebCommand({ ...cmd, __bridgeRetry: true }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).toHaveBeenCalledTimes(1);
    const acks = link.trySend.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg.commandId === 'delegate-ok-retry-1');
    expect(acks).toHaveLength(2);
    expect(acks[1]).toMatchObject({
      delegated: true,
      targetSession: 'deck_proj_w1',
      delegationContextStatus: 'ok',
      status: 'accepted',
    });
  });

  it('replays a delegated error ack for bridge retry instead of converting it to accepted', async () => {
    const link = serverLink();
    dispatchDelegatedSessionSendMock.mockResolvedValueOnce({
      status: 'error',
      error: 'delegation_target_unavailable',
      detail: 'target not found',
    });
    const cmd = {
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'bad task',
      commandId: 'delegate-error-retry-1',
      delegateTarget: { session: 'deck_proj_w404' },
    };
    handleWebCommand(cmd, link as any);
    await flushAsync();
    handleWebCommand({ ...cmd, __bridgeRetry: true }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).toHaveBeenCalledTimes(1);
    const acks = link.trySend.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg.commandId === 'delegate-error-retry-1');
    expect(acks).toHaveLength(2);
    expect(acks[0]).toMatchObject({
      status: 'error',
      error: 'delegation_target_unavailable: target not found',
      delegated: true,
      targetSession: 'deck_proj_w404',
    });
    expect(acks[1]).toMatchObject(acks[0]);
  });

  it('rejects mixed P2P fields, forbidden fields, and slash controls before dispatch', async () => {
    const link = serverLink();
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'mixed',
      commandId: 'delegate-mixed-1',
      delegateTarget: { session: 'deck_proj_w1' },
      p2pExcludeSameType: true,
    }, link as any);
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'forbidden',
      commandId: 'delegate-forbidden-1',
      delegateTarget: { session: 'deck_proj_w1' },
      origin: 'deck_other_brain',
    }, link as any);
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: '/stop',
      commandId: 'delegate-control-1',
      delegateTarget: { session: 'deck_proj_w1' },
    }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).not.toHaveBeenCalled();
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-mixed-1',
      status: 'error',
      error: 'mixed_delegation_p2p_fields',
      delegated: true,
    }));
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-forbidden-1',
      status: 'error',
      error: 'delegation_unsupported_input',
      delegated: true,
    }));
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-control-1',
      status: 'error',
      error: 'delegation_unsupported_input',
      delegated: true,
    }));
  });
});
