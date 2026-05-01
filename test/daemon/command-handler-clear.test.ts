import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID } from '../../shared/ack-protocol.js';

const {
  getSessionMock,
  relaunchSessionWithSettingsMock,
  emitMock,
  buildSessionListMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  relaunchSessionWithSettingsMock: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: buildSessionListMock }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

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
    buildSessionListMock.mockResolvedValue([]);
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
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith('deck_proj_brain', 'assistant.text', {
      text: 'Started a fresh conversation',
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
});
