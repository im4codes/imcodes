import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID } from '../../shared/ack-protocol.js';
import { DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';

const {
  getSessionMock,
  relaunchSessionWithSettingsMock,
  startSubSessionMock,
  stopSubSessionMock,
  emitMock,
  buildSessionListMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  relaunchSessionWithSettingsMock: vi.fn().mockResolvedValue(undefined),
  startSubSessionMock: vi.fn().mockResolvedValue(undefined),
  stopSubSessionMock: vi.fn().mockResolvedValue(undefined),
  emitMock: vi.fn(),
  buildSessionListMock: vi.fn(async () => []),
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
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: relaunchSessionWithSettingsMock,
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
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: emitMock, on: vi.fn(() => () => {}), off: vi.fn(), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn() } }));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: startSubSessionMock, stopSubSession: stopSubSessionMock, rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: buildSessionListMock }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));

import { handleWebCommand, handoffSessionConversation, clearTransportConversation } from '../../src/daemon/command-handler.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('process session /clear handling', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    relaunchSessionWithSettingsMock.mockReset().mockResolvedValue(undefined);
    buildSessionListMock.mockResolvedValue([]);
  });

  it('restarts a Codex sub-session in its stored directory when changing models', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_sub_child',
      projectName: 'proj',
      role: 'w1',
      agentType: 'codex',
      runtimeType: 'process',
      state: 'idle',
      projectDir: '/authoritative/project',
    });

    handleWebCommand({
      type: 'subsession.set_model',
      sessionName: 'deck_sub_child',
      model: 'gpt-5.4',
      cwd: '/untrusted/browser/path',
    }, serverLink as any);
    await flushAsync();

    expect(stopSubSessionMock).toHaveBeenCalledWith('deck_sub_child', serverLink);
    expect(startSubSessionMock).toHaveBeenCalledWith({
      id: 'child',
      type: 'codex',
      cwd: '/authoritative/project',
      codexModel: 'gpt-5.4',
    });
  });

  it('relaunches claude-code sessions fresh instead of forwarding /clear to tmux', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'idle',
      projectDir: '/proj',
      ccSessionId: 'cc-old',
    });

    handleWebCommand({ type: 'session.send', session: 'deck_proj_brain', text: '/clear', commandId: 'cmd-clear-process' }, serverLink as any);
    await flushAsync();

    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'deck_proj_brain', agentType: 'claude-code' }), { fresh: true });
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_brain',
      'user.message',
      { text: '/clear', allowDuplicate: true, commandId: 'cmd-clear-process' },
      { source: 'daemon', confidence: 'high', eventId: 'transport-user:cmd-clear-process' },
    );
    expect(emitMock).toHaveBeenCalledWith('deck_proj_brain', 'assistant.text', {
      text: 'Started a fresh conversation',
      noticeCode: DAEMON_USER_NOTICE_CODE.CONVERSATION_STARTED,
      noticeParams: {},
      streaming: false,
      memoryExcluded: true,
    }, expect.objectContaining({ source: 'daemon' }));
    expect(emitMock).toHaveBeenCalledWith('deck_proj_brain', 'command.ack', { commandId: 'cmd-clear-process', status: 'accepted' });
  });

  it('rejects a duplicate process-session commandId after it has been accepted', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'idle',
      projectDir: '/proj',
      ccSessionId: 'cc-old',
    });

    handleWebCommand({ type: 'session.send', session: 'deck_proj_brain', text: '/clear', commandId: 'cmd-clear-dup-process' }, serverLink as any);
    await flushAsync();
    handleWebCommand({ type: 'session.send', session: 'deck_proj_brain', text: '/clear', commandId: 'cmd-clear-dup-process' }, serverLink as any);
    await flushAsync();

    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('deck_proj_brain', 'command.ack', {
      commandId: 'cmd-clear-dup-process',
      status: 'error',
      error: COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    });
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-clear-dup-process',
      status: 'error',
      session: 'deck_proj_brain',
      error: COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    });
  });

  it('relaunches claude-code sessions fresh with handoff on /handoff', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'idle',
      projectDir: '/proj',
      ccSessionId: 'cc-old',
    });

    handleWebCommand({ type: 'session.send', session: 'deck_proj_brain', text: '/handoff', commandId: 'cmd-handoff-process' }, serverLink as any);
    await flushAsync();

    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deck_proj_brain', agentType: 'claude-code' }),
      { fresh: true, handoff: true },
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_brain',
      'user.message',
      { text: '/handoff', allowDuplicate: true, commandId: 'cmd-handoff-process' },
      { source: 'daemon', confidence: 'high', eventId: 'transport-user:cmd-handoff-process' },
    );
    expect(emitMock).toHaveBeenCalledWith('deck_proj_brain', 'assistant.text', {
      text: 'Started a fresh conversation',
      noticeCode: DAEMON_USER_NOTICE_CODE.CONVERSATION_STARTED,
      noticeParams: {},
      streaming: false,
      memoryExcluded: true,
    }, expect.objectContaining({ source: 'daemon' }));
    expect(emitMock).toHaveBeenCalledWith('deck_proj_brain', 'command.ack', { commandId: 'cmd-handoff-process', status: 'accepted' });
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_brain',
      'usage.update',
      expect.objectContaining({ inputTokens: 0, cacheTokens: 0, outputTokens: 0 }),
      expect.objectContaining({ source: 'daemon' }),
    );
  });

  it('emits immediate accepted ack and starting state before slow handoff completes, then resets usage to 0', async () => {
    let resolveRelaunch!: () => void;
    relaunchSessionWithSettingsMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveRelaunch = resolve; }),
    );
    getSessionMock.mockReturnValue({
      name: 'deck_proj_ag',
      projectName: 'proj',
      role: 'brain',
      agentType: 'agy-sdk',
      runtimeType: 'transport',
      state: 'idle',
      projectDir: '/proj',
      activeModel: 'claude-sonnet-4-6',
      sessionInstanceId: 'inst-1',
    });

    handleWebCommand({ type: 'session.send', session: 'deck_proj_ag', text: '/handoff', commandId: 'cmd-handoff-immediate' }, serverLink as any);
    await flushAsync();

    // Immediate UX feedback is already emitted while relaunch is still blocked.
    expect(emitMock).toHaveBeenCalledWith('deck_proj_ag', 'command.ack', { commandId: 'cmd-handoff-immediate', status: 'accepted' });
    expect(emitMock).toHaveBeenCalledWith('deck_proj_ag', 'session.state', { state: 'starting' }, expect.objectContaining({ source: 'daemon' }));
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_proj_ag',
      'assistant.text',
      expect.objectContaining({ noticeCode: DAEMON_USER_NOTICE_CODE.CONVERSATION_STARTED }),
      expect.anything(),
    );

    resolveRelaunch();
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_ag',
      'usage.update',
      expect.objectContaining({ inputTokens: 0, cacheTokens: 0, outputTokens: 0, model: 'claude-sonnet-4-6' }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_ag',
      'assistant.text',
      expect.objectContaining({ noticeCode: DAEMON_USER_NOTICE_CODE.CONVERSATION_STARTED }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(emitMock).toHaveBeenCalledWith('deck_proj_ag', 'session.state', { state: 'idle' }, expect.objectContaining({ source: 'daemon' }));
  });

  it('surfaces error ack on handoff failure, allows clean retry, and serializes concurrent resets', async () => {
    const rec = {
      name: 'deck_proj_retry',
      projectName: 'proj',
      role: 'brain',
      agentType: 'agy-sdk',
      runtimeType: 'transport',
      state: 'idle',
      projectDir: '/proj',
      sessionInstanceId: 'inst-retry',
    };
    getSessionMock.mockReturnValue(rec);
    relaunchSessionWithSettingsMock.mockRejectedValueOnce(new Error('provider down'));

    handleWebCommand({ type: 'session.send', session: 'deck_proj_retry', text: '/handoff', commandId: 'cmd-fail-1' }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith('deck_proj_retry', 'command.ack', { commandId: 'cmd-fail-1', status: 'error', error: 'provider down' });
    expect(emitMock).toHaveBeenCalledWith('deck_proj_retry', 'session.state', { state: 'idle', error: 'provider down' }, expect.objectContaining({ source: 'daemon' }));

    // Retry succeeds cleanly and concurrent handoffs execute sequentially (never overlapping).
    let active = 0;
    let maxActive = 0;
    relaunchSessionWithSettingsMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
    });
    await Promise.all([
      handoffSessionConversation(rec as any, serverLink as any),
      handoffSessionConversation(rec as any, serverLink as any),
    ]);
    expect(maxActive).toBe(1);
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(3);
  });

  it('isolates old vs new session owners when sessionInstanceId changes before/during handoff', async () => {
    const oldRec = {
      name: 'deck_proj_owner',
      projectName: 'proj',
      role: 'brain',
      agentType: 'agy-sdk',
      runtimeType: 'transport',
      state: 'idle',
      projectDir: '/proj',
      sessionInstanceId: 'inst-old',
    };
    let releaseFirst!: () => void;
    relaunchSessionWithSettingsMock.mockImplementationOnce(() => new Promise<void>((r) => { releaseFirst = r; }));
    getSessionMock.mockReturnValue(oldRec);

    const first = handoffSessionConversation(oldRec as any, serverLink as any);
    await flushAsync();

    // Simulate the session being replaced by a new owner while waiting.
    getSessionMock.mockReturnValue({ ...oldRec, sessionInstanceId: 'inst-new' });
    const staleSecond = handoffSessionConversation(oldRec as any, serverLink as any);
    releaseFirst();
    await first;
    await expect(staleSecond).rejects.toThrow(/ownership changed/i);
    // Only the first call ran; the stale second owner call aborted before relaunch.
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);
  });

  it('emits immediate receipt ack and starting state for /handoff and /clear even while a prior relaunch is pending or fails', async () => {
    const rec = {
      name: 'deck_proj_queued_ack',
      projectName: 'proj',
      role: 'brain',
      agentType: 'agy-sdk',
      runtimeType: 'transport',
      state: 'idle',
      projectDir: '/proj',
      sessionInstanceId: 'inst-queued',
    };
    getSessionMock.mockReturnValue(rec);

    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let rejectSecond!: (e: Error) => void;
    relaunchSessionWithSettingsMock
      .mockImplementationOnce(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((resolve) => {
          releaseFirst = () => {
            active -= 1;
            resolve();
          };
        });
      })
      .mockImplementationOnce(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((_, reject) => {
          rejectSecond = (e: Error) => {
            active -= 1;
            reject(e);
          };
        });
      });

    // 1) Start a slow prior restart; queued /handoff must still ack immediately without waiting.
    handleWebCommand({ type: 'session.restart', sessionName: rec.name }, serverLink as any);
    await flushAsync();
    handleWebCommand({ type: 'session.send', session: rec.name, text: '/handoff', commandId: 'cmd-queued-handoff' }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(rec.name, 'command.ack', { commandId: 'cmd-queued-handoff', status: 'accepted' });
    expect(emitMock).toHaveBeenCalledWith(rec.name, 'session.state', { state: 'starting' }, expect.objectContaining({ source: 'daemon' }));
    // Only the initial restart has started running while blocked.
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);

    // Release prior restart -> queued handoff starts and can itself be queued behind by /clear.
    releaseFirst();
    await flushAsync();
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(2);

    handleWebCommand({ type: 'session.send', session: rec.name, text: '/clear', commandId: 'cmd-queued-clear' }, serverLink as any);
    await flushAsync();
    expect(emitMock).toHaveBeenCalledWith(rec.name, 'command.ack', { commandId: 'cmd-queued-clear', status: 'accepted' });

    // Even when prior /handoff fails, cmd-queued-handoff still receives its error ack
    // without clobbering cmd-queued-clear's starting state, and cmd-queued-clear finishes cleanly.
    rejectSecond(new Error('prior failed'));
    await flushAsync();
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(rec.name, 'command.ack', {
      commandId: 'cmd-queued-handoff',
      status: 'error',
      error: 'prior failed',
    });
    expect(emitMock).not.toHaveBeenCalledWith(
      rec.name,
      'assistant.text',
      expect.objectContaining({ noticeCode: DAEMON_USER_NOTICE_CODE.CONVERSATION_CLEAR_FAILED }),
      expect.anything(),
    );
    expect(maxActive).toBe(1);
    expect(emitMock).toHaveBeenCalledWith(rec.name, 'usage.update', expect.objectContaining({ inputTokens: 0 }), expect.anything());
    expect(emitMock).toHaveBeenCalledWith(rec.name, 'session.state', { state: 'idle' }, expect.objectContaining({ source: 'daemon' }));
  });

  it('never leaks old reset failure notice, late success finalization, or deleted-session emits onto replacement or missing owners', async () => {
    const rec = {
      name: 'deck_proj_reset_isolation',
      projectName: 'proj',
      role: 'brain',
      agentType: 'agy-sdk',
      runtimeType: 'transport',
      state: 'idle',
      projectDir: '/proj',
      sessionInstanceId: 'inst-a',
    };
    getSessionMock.mockReturnValue(rec);

    // Case 1: Old owner rejects after replacement -> error ack to old commandId, zero timeline/state pollution on new owner.
    let rejectOld!: (e: Error) => void;
    relaunchSessionWithSettingsMock.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectOld = reject; }));
    handleWebCommand({ type: 'session.send', session: rec.name, text: '/handoff', commandId: 'cmd-old-fail' }, serverLink as any);
    await flushAsync();
    getSessionMock.mockReturnValue({ ...rec, state: 'working', sessionInstanceId: 'inst-b' });
    emitMock.mockClear();
    rejectOld(new Error('Session ownership changed during relaunch'));
    await flushAsync();
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(rec.name, 'command.ack', {
      commandId: 'cmd-old-fail',
      status: 'error',
      error: 'Session ownership changed during relaunch',
    });
    expect(emitMock.mock.calls.filter(([name, type]) =>
      name === rec.name && (type === 'assistant.text' || type === 'session.state' || type === 'usage.update'))).toEqual([]);

    // Case 2: Old owner resolves late after replacement -> zero finalization emitted on new owner.
    let resolveOld!: () => void;
    getSessionMock.mockReturnValue(rec);
    relaunchSessionWithSettingsMock.mockImplementationOnce(() => new Promise<void>((r) => { resolveOld = r; }));
    handleWebCommand({ type: 'session.send', session: rec.name, text: '/handoff', commandId: 'cmd-old-late-win' }, serverLink as any);
    await flushAsync();
    getSessionMock.mockReturnValue({ ...rec, state: 'working', sessionInstanceId: 'inst-c' });
    emitMock.mockClear();
    resolveOld();
    await flushAsync();
    await flushAsync();

    expect(emitMock.mock.calls.filter(([name, type]) =>
      name === rec.name && (type === 'assistant.text' || type === 'session.state' || type === 'usage.update'))).toEqual([]);

    // Case 3: Session deleted mid-handoff (both reject and late resolve paths) -> no session-level emits.
    let rejectDeleted!: (e: Error) => void;
    getSessionMock.mockReturnValue(rec);
    relaunchSessionWithSettingsMock.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectDeleted = reject; }));
    handleWebCommand({ type: 'session.send', session: rec.name, text: '/handoff', commandId: 'cmd-deleted-fail' }, serverLink as any);
    await flushAsync();
    getSessionMock.mockReturnValue(undefined);
    emitMock.mockClear();
    rejectDeleted(new Error('deleted mid-flight'));
    await flushAsync();
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(rec.name, 'command.ack', {
      commandId: 'cmd-deleted-fail',
      status: 'error',
      error: 'deleted mid-flight',
    });
    expect(emitMock.mock.calls.filter(([name, type]) =>
      name === rec.name && (type === 'assistant.text' || type === 'session.state' || type === 'usage.update'))).toEqual([]);

    let resolveDeleted!: () => void;
    getSessionMock.mockReturnValue(rec);
    relaunchSessionWithSettingsMock.mockImplementationOnce(() => new Promise<void>((r) => { resolveDeleted = r; }));
    handleWebCommand({ type: 'session.send', session: rec.name, text: '/handoff', commandId: 'cmd-deleted-win' }, serverLink as any);
    await flushAsync();
    getSessionMock.mockReturnValue(undefined);
    emitMock.mockClear();
    resolveDeleted();
    await flushAsync();
    await flushAsync();

    expect(emitMock.mock.calls.filter(([name, type]) =>
      name === rec.name && (type === 'assistant.text' || type === 'session.state' || type === 'usage.update'))).toEqual([]);
  });

  it('rejected stale-owner reset admission does not supersede an in-flight valid owner reset or suppress its completion emits', async () => {
    const recA = {
      name: 'deck_proj_stale_admission',
      projectName: 'proj',
      role: 'brain',
      agentType: 'agy-sdk',
      runtimeType: 'transport',
      state: 'idle',
      projectDir: '/proj',
      sessionInstanceId: 'inst-A',
    };
    const recB = {
      ...recA,
      sessionInstanceId: 'inst-B',
    };
    getSessionMock.mockReturnValue(recB);

    let releaseB!: () => void;
    relaunchSessionWithSettingsMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseB = resolve; }));

    handleWebCommand({ type: 'session.send', session: recB.name, text: '/handoff', commandId: 'cmd-b-valid' }, serverLink as any);
    await flushAsync();
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);

    // Stale A admission (handoff + clearTransportConversation) arrives while B's valid reset is in flight.
    await expect(handoffSessionConversation(recA as any, serverLink as any)).rejects.toThrow(/ownership changed/i);
    await expect(clearTransportConversation(recA as any, serverLink as any)).rejects.toThrow(/ownership changed/i);

    releaseB();
    await flushAsync();
    await flushAsync();

    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      recB.name,
      'usage.update',
      expect.objectContaining({ inputTokens: 0, cacheTokens: 0, outputTokens: 0 }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      recB.name,
      'assistant.text',
      expect.objectContaining({ noticeCode: DAEMON_USER_NOTICE_CODE.CONVERSATION_STARTED }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      recB.name,
      'session.state',
      { state: 'idle' },
      expect.objectContaining({ source: 'daemon' }),
    );
  });
});
