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
vi.mock('../../src/daemon/git-remote-clone.js', () => ({
  maybeCloneGitRemoteToDirectory: vi.fn(async ({ targetDir }: { targetDir: string }) => targetDir),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

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

describe('command-handler participant shell/script defense-in-depth', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
    supportsIncognitoSessions: () => true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_sub_sh1') return { name, projectName: 'proj', role: 'w1', agentType: 'shell', projectDir: '/tmp/proj', state: 'idle' };
      if (name === 'deck_sub_sc1') return { name, projectName: 'proj', role: 'w1', agentType: 'script', projectDir: '/tmp/proj', state: 'idle' };
      if (name === 'deck_proj_brain') return { name, projectName: 'proj', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/proj', state: 'idle' };
      return undefined;
    });
    listSessionsMock.mockReturnValue([]);
  });

  it.each([
    ['tab-share', TAB_PARTICIPANT],
    ['whole-server-share', SERVER_PARTICIPANT],
  ])('blocks %s participant from all 6 shell/script lifecycle, send, and input commands', async (_label, sharedActor) => {
    for (const agentType of ['shell', 'script']) {
      const targetName = agentType === 'shell' ? 'deck_sub_sh1' : 'deck_sub_sc1';

      // 1. session.input
      handleWebCommand({ type: 'session.input', sessionName: targetName, data: 'id\r', sharedActor }, serverLink as any);
      // 2. session.send
      handleWebCommand({ type: 'session.send', sessionName: targetName, text: 'whoami', commandId: `cmd-${agentType}`, sharedActor }, serverLink as any);
      // 3. session.start
      handleWebCommand({ type: 'session.start', project: 'newproj', dir: '/tmp/newproj', agentType, sharedActor }, serverLink as any);
      // 4. session.restart
      handleWebCommand({ type: 'session.restart', sessionName: targetName, sharedActor }, serverLink as any);
      handleWebCommand({ type: 'session.restart', sessionName: 'deck_proj_brain', agentType, sharedActor }, serverLink as any);
      // 5. subsession.start
      handleWebCommand({ type: 'subsession.start', id: `new${agentType}`, sessionType: agentType, parentSession: 'deck_proj_brain', sharedActor }, serverLink as any);
      // 6. subsession.restart
      handleWebCommand({ type: 'subsession.restart', sessionName: targetName, sharedActor }, serverLink as any);
      handleWebCommand({ type: 'subsession.restart', sessionName: 'deck_sub_sh1', agentType: 'claude-code', sharedActor }, serverLink as any);
    }
    await flushAsync();

    expect(sendRawInputMock).not.toHaveBeenCalled();
    expect(sendKeysMock).not.toHaveBeenCalled();
    expect(sendKeysDelayedEnterMock).not.toHaveBeenCalled();
    expect(startProjectMock).not.toHaveBeenCalled();
    expect(relaunchSessionWithSettingsMock).not.toHaveBeenCalled();
    expect(startSubSessionMock).not.toHaveBeenCalled();
    expect(launchTransportSessionMock).not.toHaveBeenCalled();
    expect(timelineEmitMock).not.toHaveBeenCalledWith(expect.any(String), 'user.message', expect.anything());
    expect(timelineEmitMock).toHaveBeenCalledWith('deck_sub_sh1', 'command.ack', expect.objectContaining({ status: 'error', error: 'participant_shell_forbidden' }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.error', message: 'participant_shell_forbidden' }));
  });

  it('allows owner shell/script operations and participant LLM session input/send/start', async () => {
    // Owner input & start on shell
    handleWebCommand({ type: 'session.input', sessionName: 'deck_sub_sh1', data: '\r' }, serverLink as any);
    handleWebCommand({ type: 'subsession.start', id: 'ownsh', sessionType: 'shell', parentSession: 'deck_proj_brain' }, serverLink as any);
    // Participant ESC interrupt on LLM process session
    handleWebCommand({ type: 'session.input', sessionName: 'deck_proj_brain', data: '\x1b', sharedActor: TAB_PARTICIPANT }, serverLink as any);
    // Participant start LLM sub-session
    handleWebCommand({ type: 'subsession.start', id: 'pcc', sessionType: 'claude-code', parentSession: 'deck_proj_brain', sharedActor: TAB_PARTICIPANT }, serverLink as any);
    await flushAsync();

    expect(sendRawInputMock).toHaveBeenCalledWith('deck_sub_sh1', '\r');
    expect(sendRawInputMock).toHaveBeenCalledWith('deck_proj_brain', '\x1b');
    expect(startSubSessionMock).toHaveBeenCalledTimes(2);
    expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'participant_shell_forbidden' }));
  });

  it('guards existing shell subsession.start targets, mixed-project restart before teardown, in-lock input race, and P2P targets', async () => {
    // 1. Existing shell sub-session target even when cmd.sessionType spoofs codex-sdk -> rejected before launch
    handleWebCommand({
      type: 'subsession.start',
      id: 'sh1',
      sessionType: 'codex-sdk',
      parentSession: 'deck_proj_brain',
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);

    // 2. Mixed project restart -> rejected BEFORE teardownProject / startProject; single LLM session restart succeeds
    listSessionsMock.mockReturnValue([
      { name: 'deck_mix_brain', projectName: 'mix', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/mix', state: 'idle' },
      { name: 'deck_mix_w1', projectName: 'mix', role: 'w1', agentType: 'shell', projectDir: '/tmp/mix', state: 'idle' },
    ]);
    handleWebCommand({
      type: 'session.restart',
      project: 'mix',
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);
    await flushAsync();

    expect(teardownProjectMock).not.toHaveBeenCalled();
    expect(startProjectMock).not.toHaveBeenCalled();
    expect(launchTransportSessionMock).not.toHaveBeenCalled();
    expect(startSubSessionMock).not.toHaveBeenCalled();

    // Single LLM session restart in the mixed project still succeeds
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_mix_brain') return { name, projectName: 'mix', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/mix', state: 'idle' };
      return undefined;
    });
    handleWebCommand({
      type: 'session.restart',
      sessionName: 'deck_mix_brain',
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);
    await flushAsync();
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);

    // 3. Race: handleInput starts on claude-code then session switches to shell before inside-mutex write
    let calls = 0;
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_race_brain') {
        calls += 1;
        return {
          name,
          projectName: 'race',
          role: 'brain',
          agentType: calls === 1 ? 'claude-code' : 'shell',
          projectDir: '/tmp/race',
          state: 'idle',
        };
      }
      return undefined;
    });
    handleWebCommand({
      type: 'session.input',
      sessionName: 'deck_race_brain',
      data: 'ls\r',
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);
    await flushAsync();
    expect(sendRawInputMock).not.toHaveBeenCalled();

    // 4. Structured P2P targets containing shell/script rejected before startP2pRun
    getSessionMock.mockImplementation((name: string) => {
      if (name === 'deck_proj_brain') return { name, projectName: 'proj', role: 'brain', agentType: 'claude-code', projectDir: '/tmp/proj', state: 'idle' };
      if (name === 'deck_sub_sh1') return { name, projectName: 'proj', role: 'w1', agentType: 'shell', projectDir: '/tmp/proj', state: 'idle' };
      return undefined;
    });
    handleWebCommand({
      type: 'session.send',
      sessionName: 'deck_proj_brain',
      text: 'review this',
      commandId: 'p2p-mix-cmd',
      p2pAtTargets: [{ session: 'deck_sub_sh1', mode: 'audit' }],
      sharedActor: SERVER_PARTICIPANT,
    }, serverLink as any);
    await vi.waitFor(() => {
      expect(timelineEmitMock).toHaveBeenCalledWith('deck_proj_brain', 'command.ack', expect.objectContaining({
        commandId: 'p2p-mix-cmd',
        status: 'error',
        error: 'participant_shell_forbidden',
      }));
    });
  });
});
