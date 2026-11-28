import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  startProjectMock,
  teardownProjectMock,
  launchTransportSessionMock,
  relaunchSessionWithSettingsMock,
  startSubSessionMock,
  sendRawInputMock,
  sendKeysMock,
  sendKeysDelayedEnterMock,
  getSessionMock,
  listSessionsMock,
  timelineEmitMock,
  emitCommandAckReliableMock,
  startP2pRunMock,
  scheduleCatchupMock,
} = vi.hoisted(() => ({
  startProjectMock: vi.fn(),
  teardownProjectMock: vi.fn(),
  launchTransportSessionMock: vi.fn(),
  relaunchSessionWithSettingsMock: vi.fn(),
  startSubSessionMock: vi.fn(),
  sendRawInputMock: vi.fn(),
  sendKeysMock: vi.fn(),
  sendKeysDelayedEnterMock: vi.fn(),
  getSessionMock: vi.fn(),
  listSessionsMock: vi.fn(() => []),
  timelineEmitMock: vi.fn(),
  emitCommandAckReliableMock: vi.fn(),
  startP2pRunMock: vi.fn(async () => ({ id: 'p2p-run-1' })),
  scheduleCatchupMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: listSessionsMock,
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: startProjectMock,
  stopProject: vi.fn(),
  teardownProject: teardownProjectMock,
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: launchTransportSessionMock,
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: relaunchSessionWithSettingsMock,
  stopTransportRuntimeSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  sendKeys: sendKeysMock,
  sendKeysDelayedEnter: sendKeysDelayedEnterMock,
  sendRawInput: sendRawInputMock,
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
  preparePrivateInputWriter: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn(), invalidateSize: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: timelineEmitMock, on: vi.fn(() => () => {}), off: vi.fn(), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn() } }));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: startSubSessionMock, stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: startP2pRunMock, cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  scheduleCatchup: scheduleCatchupMock,
}));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));
vi.mock('../../src/daemon/git-remote-clone.js', () => ({
  maybeCloneGitRemoteToDirectory: vi.fn(async ({ targetDir }: { targetDir: string }) => targetDir),
}));

import {
  clearProcessAutomationQueuesForTest,
  drainProcessAutomationQueue,
  getProcessAutomationQueueDepth,
  handleWebCommand,
  sendProcessSessionMessageForAutomation,
} from '../../src/daemon/command-handler.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const TAB_PARTICIPANT = {
  actorUserId: 'user-p1',
  actorDisplayName: 'Participant',
  effectiveActorRole: 'participant',
  origin: 'shared-tab',
  actionId: 'act-1',
  primaryShareId: 'share-1',
  authorizedAt: 1000,
  snapshot: {
    target: { kind: 'subsession', serverId: 'srv-1', subSessionId: 'sh1' },
    effectiveRole: 'participant',
    historyCutoffAt: 0,
    nextCoverageRecheckAt: null,
    coveringShareIds: ['share-1'],
    primaryShareId: 'share-1',
    authorizedAt: 1000,
  },
};

const SERVER_PARTICIPANT = {
  ...TAB_PARTICIPANT,
  origin: 'shared-server',
  snapshot: {
    ...TAB_PARTICIPANT.snapshot,
    target: { kind: 'server', serverId: 'srv-1' },
    serverParticipantAuthority: true,
  },
};

describe('command-handler participant shell/script execution', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
    supportsIncognitoSessions: () => true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearProcessAutomationQueuesForTest();
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_sub_sh1') return { name, projectName: 'proj', role: 'w1', agentType: 'shell', runtimeType: 'process', projectDir: '/tmp/proj', state: 'idle' };
      if (name === 'deck_sub_sc1') return { name, projectName: 'proj', role: 'w1', agentType: 'script', runtimeType: 'process', projectDir: '/tmp/proj', state: 'idle' };
      if (name === 'deck_proj_brain') return { name, projectName: 'proj', role: 'brain', agentType: 'claude-code', runtimeType: 'process', projectDir: '/tmp/proj', state: 'idle' };
      return undefined;
    });
    listSessionsMock.mockReturnValue([]);
  });

  it.each([
    ['tab-share', TAB_PARTICIPANT],
    ['whole-server-share', SERVER_PARTICIPANT],
  ])('allows %s participant shell/script lifecycle, send, and input commands within authorized scope', async (label, sharedActor) => {
    relaunchSessionWithSettingsMock.mockResolvedValue(undefined);
    startSubSessionMock.mockResolvedValue(undefined);
    startProjectMock.mockResolvedValue(undefined);

    for (const agentType of ['shell', 'script']) {
      const targetName = agentType === 'shell' ? 'deck_sub_sh1' : 'deck_sub_sc1';

      handleWebCommand({ type: 'session.input', sessionName: targetName, data: 'id\r', sharedActor }, serverLink as any);
      handleWebCommand({ type: 'session.send', sessionName: targetName, text: 'whoami', commandId: `cmd-${label}-${agentType}`, sharedActor }, serverLink as any);
      handleWebCommand({ type: 'session.start', project: `new-${label}-${agentType}`, dir: `/tmp/new-${label}-${agentType}`, agentType, sharedActor }, serverLink as any);
      handleWebCommand({ type: 'subsession.start', id: `new${label.replace(/[^a-z]/g, '')}${agentType}`, sessionType: agentType, parentSession: 'deck_proj_brain', sharedActor }, serverLink as any);
      handleWebCommand({ type: 'session.restart', sessionName: targetName, sharedActor }, serverLink as any);
      await flushAsync();
      handleWebCommand({ type: 'subsession.restart', sessionName: targetName, sharedActor }, serverLink as any);
      await flushAsync();
    }
    await vi.waitFor(() => {
      expect(sendRawInputMock).toHaveBeenCalledTimes(2);
      expect(sendKeysDelayedEnterMock).toHaveBeenCalledTimes(2);
      expect(startProjectMock).toHaveBeenCalledTimes(2);
      expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(4);
      expect(startSubSessionMock).toHaveBeenCalledTimes(2);
    }, { timeout: 3000 });
    expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'participant_shell_forbidden' }));
  });

  it('allows owner shell/script operations and participant mixed-project restart, recovery, and P2P shell targets', async () => {
    relaunchSessionWithSettingsMock.mockResolvedValue(undefined);
    startProjectMock.mockResolvedValue(undefined);
    teardownProjectMock.mockResolvedValue(undefined);

    // Owner + participant shell operations succeed
    handleWebCommand({ type: 'session.input', sessionName: 'deck_sub_sh1', data: '\r' }, serverLink as any);
    handleWebCommand({ type: 'session.input', sessionName: 'deck_proj_brain', data: '\x1b', sharedActor: TAB_PARTICIPANT }, serverLink as any);
    await flushAsync();
    expect(sendRawInputMock).toHaveBeenCalledWith('deck_sub_sh1', '\r');
    expect(sendRawInputMock).toHaveBeenCalledWith('deck_proj_brain', '\x1b');

    // Mixed project restart succeeds for whole-server participant
    listSessionsMock.mockReturnValue([
      { name: 'deck_mix_brain', projectName: 'mix', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/mix', state: 'idle' },
      { name: 'deck_mix_w1', projectName: 'mix', role: 'w1', agentType: 'shell', projectDir: '/tmp/mix', state: 'idle' },
    ]);
    handleWebCommand({
      type: 'session.restart',
      project: 'mix',
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);
    await vi.waitFor(() => {
      expect(teardownProjectMock).toHaveBeenCalledWith('mix');
      expect(startProjectMock).toHaveBeenCalledTimes(1);
    });

    // Structured P2P target pointing to shell sub-session succeeds for participant
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'review this',
      commandId: 'p2p-mix-cmd',
      p2pAtTargets: [{ session: 'deck_sub_sh1', mode: 'audit' }],
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);
    await vi.waitFor(() => {
      expect(startP2pRunMock).toHaveBeenCalledTimes(1);
    });
    expect(startP2pRunMock.mock.calls[0]?.[0].targets).toEqual([{ session: 'deck_sub_sh1', mode: 'audit' }]);

    // Tmux recovery after input error works cleanly for participant on shell session too
    relaunchSessionWithSettingsMock.mockClear();
    sendRawInputMock.mockReset();
    serverLink.send.mockClear();
    getSessionMock.mockReturnValue({
      name: 'deck_recsh_brain',
      projectName: 'recsh',
      role: 'brain',
      agentType: 'shell',
      projectDir: '/tmp/recsh',
      state: 'idle',
    });
    sendRawInputMock.mockRejectedValueOnce(new Error("can't find pane")).mockResolvedValueOnce(undefined);
    handleWebCommand({
      type: 'session.input',
      sessionName: 'deck_recsh_brain',
      data: 'whoami\r',
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);
    await vi.waitFor(() => {
      expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);
      expect(sendRawInputMock).toHaveBeenCalledTimes(2);
    });

    // Direct automation send abort via custom beforeTyping still propagates cleanly
    const autoResult = await sendProcessSessionMessageForAutomation('deck_recsh_brain', 'ping', {
      verbatim: true,
      beforeTyping: () => false,
    });
    expect(autoResult).toBe('aborted');
  });

  it('invokes onAborted and continues draining queued automation messages when in-lock guard returns false', async () => {
    let qState: 'running' | 'idle' = 'running';
    let qAgentType = 'claude-code';
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_qdrain_brain') {
        return {
          name,
          projectName: 'qdrain',
          role: 'brain',
          agentType: qAgentType,
          projectDir: '/tmp/qdrain',
          state: qState,
          runtimeType: 'process',
        };
      }
      return undefined;
    });

    const onAborted1 = vi.fn();
    const onTyped1 = vi.fn();
    const onAborted2 = vi.fn();
    const onTyped2 = vi.fn();
    let checkCalls = 0;

    const q1 = await sendProcessSessionMessageForAutomation('deck_qdrain_brain', 'first-aborts-in-lock', {
      deliveryMode: 'queue',
      verbatim: true,
      // Passes queue pre-check (call 1), fails inside mutex (call 2)
      beforeTyping: () => {
        checkCalls += 1;
        return checkCalls === 1;
      },
      onAborted: onAborted1,
      onTyped: onTyped1,
    });
    const q2 = await sendProcessSessionMessageForAutomation('deck_qdrain_brain', 'second-succeeds', {
      deliveryMode: 'queue',
      verbatim: true,
      beforeTyping: () => qAgentType !== 'shell',
      onAborted: onAborted2,
      onTyped: onTyped2,
    });
    expect(q1).toBe('queued');
    expect(q2).toBe('queued');
    expect(getProcessAutomationQueueDepth('deck_qdrain_brain')).toBe(2);

    qState = 'idle';
    await drainProcessAutomationQueue('deck_qdrain_brain');

    expect(onAborted1).toHaveBeenCalledTimes(1);
    expect(onTyped1).not.toHaveBeenCalled();
    expect(onAborted2).not.toHaveBeenCalled();
    expect(onTyped2).toHaveBeenCalledTimes(1);
    expect(sendKeysDelayedEnterMock).toHaveBeenCalledTimes(1);
    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith('deck_qdrain_brain', 'second-succeeds', { verbatim: true });
    expect(getProcessAutomationQueueDepth('deck_qdrain_brain')).toBe(0);
  });

  it('runs OpenCode scheduleCatchup after successful process sends and skips it when blocked before typing', async () => {
    let ocAgentType = 'opencode';
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_oc_brain') {
        return {
          name,
          projectName: 'oc',
          role: 'brain',
          agentType: ocAgentType,
          projectDir: '/tmp/oc',
          state: 'idle',
          runtimeType: 'process',
        };
      }
      return undefined;
    });

    const sentRes = await sendProcessSessionMessageForAutomation('deck_oc_brain', 'hello opencode', {
      verbatim: true,
      userMessageMetadata: { sharedActor: SERVER_PARTICIPANT },
    });
    expect(sentRes).toBe('sent');
    expect(scheduleCatchupMock).toHaveBeenCalledTimes(1);
    expect(scheduleCatchupMock).toHaveBeenCalledWith('deck_oc_brain');

    scheduleCatchupMock.mockClear();
    sendKeysDelayedEnterMock.mockClear();
    const blockedRes = await sendProcessSessionMessageForAutomation('deck_oc_brain', 'blocked opencode', {
      verbatim: true,
      beforeTyping: () => false,
      userMessageMetadata: { sharedActor: SERVER_PARTICIPANT },
    });
    expect(blockedRes).toBe('aborted');
    expect(scheduleCatchupMock).not.toHaveBeenCalled();
    expect(sendKeysDelayedEnterMock).not.toHaveBeenCalled();
  });
});
