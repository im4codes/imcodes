import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';

const {
  getSessionMock,
  upsertSessionMock,
  getTransportRuntimeMock,
  emitMock,
  launchTransportSessionMock,
  relaunchSessionWithSettingsMock,
  stopTransportRuntimeSessionMock,
  resizeSessionMock,
  terminalSubscribeMock,
  terminalRequestSnapshotMock,
  supervisionDecideMock,
  queueTaskIntentMock,
  registerTaskIntentMock,
  applySnapshotUpdateMock,
  updateQueuedTaskIntentMock,
  removeQueuedTaskIntentMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  emitMock: vi.fn(),
  launchTransportSessionMock: vi.fn().mockResolvedValue(undefined),
  relaunchSessionWithSettingsMock: vi.fn(),
  stopTransportRuntimeSessionMock: vi.fn().mockResolvedValue(undefined),
  resizeSessionMock: vi.fn(),
  terminalSubscribeMock: vi.fn(() => vi.fn()),
  terminalRequestSnapshotMock: vi.fn(),
  supervisionDecideMock: vi.fn(async () => ({ decision: 'complete', reason: 'ok', confidence: 0.9 })),
  queueTaskIntentMock: vi.fn(),
  registerTaskIntentMock: vi.fn(),
  applySnapshotUpdateMock: vi.fn(),
  updateQueuedTaskIntentMock: vi.fn(),
  removeQueuedTaskIntentMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: getTransportRuntimeMock,
  launchTransportSession: launchTransportSessionMock,
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

vi.mock('../../src/daemon/supervision-broker.js', () => ({
  supervisionBroker: {
    decide: supervisionDecideMock,
  },
}));

vi.mock('../../src/daemon/supervision-automation.js', () => ({
  supervisionAutomation: {
    init: vi.fn(),
    setServerLink: vi.fn(),
    cancelSession: vi.fn(),
    queueTaskIntent: queueTaskIntentMock,
    registerTaskIntent: registerTaskIntentMock,
    applySnapshotUpdate: applySnapshotUpdateMock,
    updateQueuedTaskIntent: updateQueuedTaskIntentMock,
    removeQueuedTaskIntent: removeQueuedTaskIntentMock,
  },
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
    supervisionDecideMock.mockResolvedValue({ decision: 'complete', reason: 'ok', confidence: 0.9 });
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
    });
  });

  it('emits queued session.state for queued transport sends without adding a timeline row', async () => {
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
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.objectContaining({ clientMessageId: 'cmd-queued', pending: true }),
      expect.anything(),
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-queued', status: 'accepted' });
  });

  it('dispatches /clear as a fresh claude-code-sdk relaunch', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      label: 'Brain',
      description: 'desc',
      requestedModel: 'sonnet',
      effort: 'high',
      transportConfig: { supervision: { mode: 'off' } },
      ccPreset: 'preset-a',
      ccSessionId: 'cc-old',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      cancel: vi.fn(),
      send: vi.fn(() => 'queued'),
      pendingCount: 2,
      pendingMessages: ['a', 'b'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-cc' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'claude-code-sdk',
      projectDir: '/proj',
      label: 'Brain',
      description: 'desc',
      requestedModel: 'sonnet',
      effort: 'high',
      transportConfig: { supervision: { mode: 'off' } },
      ccPreset: 'preset-a',
      fresh: true,
      ccSessionId: expect.any(String),
    }));
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: '/clear', allowDuplicate: true, commandId: 'cmd-clear-cc' },
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'assistant.text', {
      text: 'Started a fresh conversation',
      streaming: false,
      memoryExcluded: true,
    }, expect.objectContaining({ source: 'daemon' }));
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-cc', status: 'accepted' });
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({ state: 'queued' }),
      expect.anything(),
    );
  });

  it('passes requestedModel when starting a copilot-sdk main session', async () => {
    handleWebCommand({
      type: 'session.start',
      project: 'transport',
      dir: '/proj',
      agentType: 'copilot-sdk',
      requestedModel: 'gpt-5.4-mini',
      thinking: 'high',
    }, serverLink as any);
    await flushAsync();

    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'copilot-sdk',
      projectDir: '/proj',
      requestedModel: 'gpt-5.4-mini',
      effort: 'high',
    }));
  });

  it('passes requestedModel when starting a cursor-headless main session', async () => {
    handleWebCommand({
      type: 'session.start',
      project: 'transport',
      dir: '/proj',
      agentType: 'cursor-headless',
      requestedModel: 'gpt-5.2',
    }, serverLink as any);
    await flushAsync();

    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'cursor-headless',
      projectDir: '/proj',
      requestedModel: 'gpt-5.2',
    }));
  });

  it('dispatches /clear as a fresh openclaw relaunch that preserves the provider key', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'openclaw',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      providerSessionId: 'agent___main___discord___chan',
      requestedModel: 'oc-model',
      effort: 'medium',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'agent___main___discord___chan',
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['a'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-oc' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'openclaw',
      projectDir: '/proj',
      requestedModel: 'oc-model',
      effort: 'medium',
      bindExistingKey: 'agent___main___discord___chan',
      fresh: true,
    }));
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-oc', status: 'accepted' });
  });

  it('dispatches /clear as a fresh qwen relaunch without preserving the provider key', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      providerSessionId: 'qwen-route-old',
      requestedModel: 'qwen-plus',
      effort: 'low',
      ccPreset: 'preset-q',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'qwen-route-old',
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['a'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-qwen' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'qwen',
      projectDir: '/proj',
      requestedModel: 'qwen-plus',
      effort: 'low',
      ccPreset: 'preset-q',
      fresh: true,
    }));
    expect(launchTransportSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('bindExistingKey');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-qwen', status: 'accepted' });
  });

  it('dispatches /clear as a fresh codex-sdk relaunch', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      requestedModel: 'gpt-5.4-codex',
      effort: 'medium',
      codexSessionId: 'thread-old',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-codex-old',
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['a'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-codex' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'codex-sdk',
      projectDir: '/proj',
      requestedModel: 'gpt-5.4-codex',
      effort: 'medium',
      fresh: true,
    }));
    expect(launchTransportSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('bindExistingKey');
    expect(launchTransportSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('codexSessionId');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-codex', status: 'accepted' });
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
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: '/stop', allowDuplicate: true, commandId: 'cmd-stop' },
      undefined,
    );
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

    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: 'sent msg', allowDuplicate: true, commandId: 'cmd-sent', clientMessageId: 'cmd-sent' },
      expect.objectContaining({ eventId: 'transport-user:cmd-sent' }),
    );
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
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: '你在用什么模型', allowDuplicate: true, commandId: 'cmd-identity', clientMessageId: 'cmd-identity' },
      expect.objectContaining({ eventId: 'transport-user:cmd-identity' }),
    );
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({ text: expect.any(String), streaming: false }),
      expect.anything(),
    );
  });

  it('queues sends for resend when the transport runtime has not connected yet', async () => {
    // Reset module state between tests — the queue lives in module scope.
    const { clearAllResend, getResendEntries } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      state: 'idle',
    });
    // No runtime yet — provider is still reconnecting.
    getTransportRuntimeMock.mockReturnValue(undefined);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'first msg while offline',
      commandId: 'cmd-offline-1',
    }, serverLink as any);
    await flushAsync();

    // 1. Command is accepted, NOT errored — we queued it, we didn't drop it.
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'command.ack',
      { commandId: 'cmd-offline-1', status: 'accepted' },
    );
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-offline-1',
      status: 'accepted',
      session: 'deck_transport_brain',
    });
    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'claude-code-sdk',
      projectName: 'transport',
    }));

    // 2. NO user.message timeline event — the agent hasn't seen this message
    //    yet, it's sitting in the daemon's resend queue. Emitting a
    //    user.message here would lie to the timeline: committed rows mean
    //    "the agent saw this". The optimistic pending bubble on the web
    //    client stays in its "sending" state, and the real user.message
    //    event fires on drain when runtime.send() actually dispatches.
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.anything(),
      expect.anything(),
    );

    // 3. A memory-excluded info message explains the queued state.
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({
        text: expect.stringContaining('will resend 1 queued message'),
        streaming: false,
        memoryExcluded: true,
      }),
      expect.objectContaining({ source: 'daemon' }),
    );

    // 4. session.state reports the queued entry so the UI can surface pending count.
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({
        state: 'queued',
        pendingCount: 1,
        pendingMessageEntries: [
          { clientMessageId: 'cmd-offline-1', text: 'first msg while offline' },
        ],
      }),
      expect.objectContaining({ source: 'daemon' }),
    );

    // 5. The entry is actually sitting in the resend queue for later drain.
    expect(getResendEntries('deck_transport_brain')).toEqual([
      expect.objectContaining({ text: 'first msg while offline', commandId: 'cmd-offline-1' }),
    ]);

    // A second offline send accumulates.
    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'second msg while offline',
      commandId: 'cmd-offline-2',
    }, serverLink as any);
    await flushAsync();

    expect(getResendEntries('deck_transport_brain').map((e) => e.commandId)).toEqual([
      'cmd-offline-1',
      'cmd-offline-2',
    ]);

    // Cleanup so later tests start from empty state.
    clearAllResend();
  });

  it('queues SDK sends by agentType when runtimeType has not propagated yet', async () => {
    const { clearAllResend, getResendEntries } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'gemini-sdk',
      providerId: 'gemini-sdk',
      state: 'idle',
    });
    getTransportRuntimeMock.mockReturnValue(undefined);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model gemini-2.5-pro',
      commandId: 'cmd-missing-runtime-type-model',
    }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'command.ack',
      { commandId: 'cmd-missing-runtime-type-model', status: 'accepted' },
    );
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.anything(),
      expect.anything(),
    );
    expect(getResendEntries('deck_transport_brain')).toEqual([
      expect.objectContaining({ text: '/model gemini-2.5-pro', commandId: 'cmd-missing-runtime-type-model' }),
    ]);

    clearAllResend();
  });

  it('persists a transport error record when subsession.start fails before runtime creation', async () => {
    launchTransportSessionMock.mockRejectedValueOnce(new Error('provider bootstrap failed'));

    handleWebCommand({
      type: 'subsession.start',
      id: 'cursor_fail',
      sessionType: 'cursor-headless',
      cwd: '/tmp/project',
      parentSession: 'deck_proj_brain',
      requestedModel: 'gpt-5.4',
    }, serverLink as any);
    await flushAsync();

    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_cursor_fail',
      agentType: 'cursor-headless',
      projectDir: '/tmp/project',
      runtimeType: 'transport',
      providerId: 'cursor-headless',
      state: 'error',
      parentSession: 'deck_proj_brain',
      requestedModel: 'gpt-5.4',
      userCreated: true,
    }));
    expect(emitMock).toHaveBeenCalledWith(
      'deck_sub_cursor_fail',
      'session.state',
      expect.objectContaining({ state: 'error', error: 'provider bootstrap failed' }),
      expect.objectContaining({ source: 'daemon' }),
    );
  });

  it('tracks supervision task intents while offline so Auto still follows the resent turn', async () => {
    const { clearAllResend } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      state: 'idle',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue(undefined);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'offline supervised task',
      commandId: 'cmd-offline-supervised',
    }, serverLink as any);
    await flushAsync();

    expect(queueTaskIntentMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'cmd-offline-supervised',
      'offline supervised task',
      expect.objectContaining({
        mode: 'supervised',
        backend: 'codex-sdk',
        model: 'gpt-5.4',
      }),
    );

    clearAllResend();
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

    // Reset the resend queue so entries from earlier tests don't leak in.
    const { clearAllResend, getResendEntries } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'hello after restart',
      commandId: 'cmd-stale-runtime',
    }, serverLink as any);
    await flushAsync();

    // New behavior: the runtime-without-providerSessionId branch auto-resumes
    // instead of erroring. The user message is preserved, enqueued for
    // redelivery, and the command ack is `accepted` (not `error`) so the UI
    // doesn't stay stuck in a "failed send" state.
    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    // No user.message emission on the stale-runtime queue path either —
    // the message is only in daemon memory, not yet re-dispatched. The
    // drain helper (launchTransportSession / restoreTransportSessions)
    // emits user.message when runtime.send() returns 'sent'.
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.anything(),
      expect.anything(),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({
        text: expect.stringContaining('will auto-resend'),
        streaming: false,
        memoryExcluded: true,
      }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({
        state: 'queued',
        pendingCount: 1,
        pendingMessageEntries: [
          { clientMessageId: 'cmd-stale-runtime', text: 'hello after restart' },
        ],
      }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-stale-runtime',
      status: 'accepted',
      session: 'deck_transport_brain',
    });
    // The entry sits in the resend queue until the resumed runtime drains it.
    expect(getResendEntries('deck_transport_brain')).toEqual([
      expect.objectContaining({ text: 'hello after restart', commandId: 'cmd-stale-runtime' }),
    ]);
    clearAllResend();
  });

  it('tracks supervision task intents when the runtime is queued for auto-resume', async () => {
    const { clearAllResend } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      state: 'idle',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    });
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
      text: 'resume supervised task',
      commandId: 'cmd-resume-supervised',
    }, serverLink as any);
    await flushAsync();

    expect(queueTaskIntentMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'cmd-resume-supervised',
      'resume supervised task',
      expect.objectContaining({
        mode: 'supervised',
        backend: 'codex-sdk',
        model: 'gpt-5.4',
      }),
    );

    clearAllResend();
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
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: 'after restart', allowDuplicate: true, commandId: 'cmd-after-restart', clientMessageId: 'cmd-after-restart' },
      expect.objectContaining({ eventId: 'transport-user:cmd-after-restart' }),
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-after-restart', status: 'accepted' });
  });

  it('applies live transport-config updates to the daemon session store', async () => {
    const updatedRecord = {
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 12000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    };
    getSessionMock
      .mockReturnValueOnce({
        name: 'deck_transport_brain',
        projectName: 'transport',
        role: 'brain',
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        state: 'running',
        transportConfig: null,
      })
      .mockImplementation(() => updatedRecord as any);

    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_transport_brain',
      transportConfig: updatedRecord.transportConfig,
    }, serverLink as any);
    await flushAsync();

    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      transportConfig: updatedRecord.transportConfig,
    }));
  });

  it('registers eligible supervised task messages immediately when the transport send dispatches now', async () => {
    const transportSend = vi.fn(() => 'sent');
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          auditMode: 'audit',
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'implement the feature',
      commandId: 'cmd-heavy',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('implement the feature', 'cmd-heavy');
    expect(registerTaskIntentMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'cmd-heavy',
      'implement the feature',
      expect.objectContaining({ mode: 'supervised_audit' }),
    );
    expect(queueTaskIntentMock).not.toHaveBeenCalled();
  });

  it('marks transport control-plane success messages as automation so supervision does not capture them as task completions', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'cursor-headless',
      runtimeType: 'transport',
      state: 'running',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      setAgentId,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model gpt-5.4',
      commandId: 'cmd-model-switch',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('gpt-5.4');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({
        text: 'Switched model to gpt-5.4',
        streaming: false,
        automation: true,
        memoryExcluded: true,
      }),
      expect.any(Object),
    );
  });

  it('updates live supervision state when the browser patches transportConfig', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: null,
    });

    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_transport_brain',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    }, serverLink as any);
    await flushAsync();

    expect(applySnapshotUpdateMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      expect.objectContaining({
        mode: 'supervised',
        backend: 'codex-sdk',
      }),
    );
  });

  it('does not create a heavy-mode task run for slash commands', async () => {
    const transportSend = vi.fn(() => 'sent');
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          auditMode: 'audit',
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/status',
      commandId: 'cmd-status',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('/status', 'cmd-status');
    expect(queueTaskIntentMock).not.toHaveBeenCalled();
  });

  it('falls back to the normal manual send path when the persisted supervision snapshot is invalid', async () => {
    const transportSend = vi.fn(() => 'sent');
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'bad-backend',
          model: '',
          timeoutMs: 0,
          promptVersion: '',
          maxParseRetries: 0,
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'normal message',
      commandId: 'cmd-invalid-supervision',
    }, serverLink as any);
    await flushAsync();

    expect(supervisionDecideMock).not.toHaveBeenCalled();
    expect(transportSend).toHaveBeenCalledWith('normal message', 'cmd-invalid-supervision');
  });

  it('edits a queued transport message by clientMessageId', async () => {
    const editPendingMessage = vi.fn(() => true);
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      editPendingMessage,
      sending: true,
      pendingCount: 1,
      pendingMessages: ['edited queued'],
      pendingEntries: [{ clientMessageId: 'cmd-queued', text: 'edited queued' }],
    });

    handleWebCommand({
      type: 'session.edit_queued_message',
      sessionName: 'deck_transport_brain',
      clientMessageId: 'cmd-queued',
      text: 'edited queued',
      commandId: 'cmd-edit',
    }, serverLink as any);
    await flushAsync();

    expect(editPendingMessage).toHaveBeenCalledWith('cmd-queued', 'edited queued');
    expect(updateQueuedTaskIntentMock).toHaveBeenCalledWith('deck_transport_brain', 'cmd-queued', 'edited queued');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      {
        state: 'queued',
        pendingCount: 1,
        pendingMessages: ['edited queued'],
        pendingMessageEntries: [{ clientMessageId: 'cmd-queued', text: 'edited queued' }],
      },
      expect.any(Object),
    );
  });

  it('removes a queued transport message by clientMessageId', async () => {
    const removePendingMessage = vi.fn(() => ({ clientMessageId: 'cmd-queued', text: 'queued msg' }));
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      removePendingMessage,
      sending: true,
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });

    handleWebCommand({
      type: 'session.undo_queued_message',
      sessionName: 'deck_transport_brain',
      clientMessageId: 'cmd-queued',
      commandId: 'cmd-undo',
    }, serverLink as any);
    await flushAsync();

    expect(removePendingMessage).toHaveBeenCalledWith('cmd-queued');
    expect(removeQueuedTaskIntentMock).toHaveBeenCalledWith('deck_transport_brain', 'cmd-queued');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      { state: 'queued', pendingCount: 0, pendingMessages: [], pendingMessageEntries: [] },
      expect.any(Object),
    );
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

  it('forwards transport approval responses to the live runtime and rebroadcasts them', async () => {
    const respondApproval = vi.fn().mockResolvedValue(undefined);
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'copilot-sdk',
      runtimeType: 'transport',
      state: 'running',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      respondApproval,
    });

    await handleWebCommand({
      type: TRANSPORT_MSG.APPROVAL_RESPONSE,
      sessionId: 'deck_transport_brain',
      requestId: 'approval-1',
      approved: true,
    }, serverLink as any);
    await flushAsync();

    expect(respondApproval).toHaveBeenCalledWith('approval-1', true);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TRANSPORT_MSG.APPROVAL_RESPONSE,
      sessionId: 'deck_transport_brain',
      requestId: 'approval-1',
      approved: true,
    }));
  });

  it('switches model for copilot-sdk transport sessions via /model', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'copilot-sdk',
      runtimeType: 'transport',
      state: 'running',
      requestedModel: 'gpt-5.4',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      setAgentId,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model gpt-5.4-mini',
      commandId: 'cmd-model-copilot',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('gpt-5.4-mini');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: 'gpt-5.4-mini',
      activeModel: 'gpt-5.4-mini',
      modelDisplay: 'gpt-5.4-mini',
    }));
  });

  it('switches model for gemini-sdk transport sessions via /model', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'gemini-sdk',
      runtimeType: 'transport',
      state: 'running',
      requestedModel: 'gemini-2.5-pro',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      setAgentId,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model auto',
      commandId: 'cmd-model-gemini',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('auto');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: 'auto',
      activeModel: 'auto',
      modelDisplay: 'auto',
    }));
  });

  it('switches model for cursor-headless transport sessions via /model', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'cursor-headless',
      runtimeType: 'transport',
      state: 'running',
      requestedModel: 'gpt-5.2',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      setAgentId,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model claude-sonnet-4.6',
      commandId: 'cmd-model-cursor',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('claude-sonnet-4.6');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: 'claude-sonnet-4.6',
      activeModel: 'claude-sonnet-4.6',
      modelDisplay: 'claude-sonnet-4.6',
    }));
  });
});
