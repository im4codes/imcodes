import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const {
  getSessionMock,
  listSessionsMock,
  relaunchSessionWithSettingsMock,
  emitSessionInlineErrorMock,
  buildSessionListMock,
  sendSubSessionSyncMock,
  loggerWarnMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn<() => SessionRecord | null>(() => null),
  listSessionsMock: vi.fn<() => SessionRecord[]>(() => []),
  relaunchSessionWithSettingsMock: vi.fn(),
  emitSessionInlineErrorMock: vi.fn(),
  buildSessionListMock: vi.fn(async () => [{ name: 'deck_proj_brain', state: 'idle' }]),
  sendSubSessionSyncMock: vi.fn(async () => {}),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: (project?: string) => {
    const all = listSessionsMock();
    return project ? all.filter((s) => s.projectName === project) : all;
  },
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
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
  getDriver: vi.fn(),
}));

vi.mock('../../src/daemon/session-error.js', () => ({
  emitSessionInlineError: emitSessionInlineErrorMock,
}));

vi.mock('../../src/daemon/session-list.js', () => ({
  buildSessionList: buildSessionListMock,
}));

vi.mock('../../src/daemon/subsession-sync.js', () => ({
  sendSubSessionSync: sendSubSessionSyncMock,
  announceSubSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
  preparePrivateInputWriter: vi.fn(),
  newSession: vi.fn(),
  killSession: vi.fn(),
  sessionExists: vi.fn().mockResolvedValue(false),
  getPaneId: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn(), readPreferred: vi.fn(async () => []) } }));
vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: vi.fn(),
  stopSubSession: vi.fn(),
  rebuildSubSessions: vi.fn(),
  detectShells: vi.fn().mockResolvedValue([]),
  readSubSessionResponse: vi.fn(),
  subSessionName: (id: string) => `deck_sub_${id}`,
}));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/openspec-auto-deliver-orchestrator.js', () => ({ handleOpenSpecAutoDeliverCommand: vi.fn(), getActiveOpenSpecAutoDeliverRunsBlockingDaemonUpgrade: vi.fn(() => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileUploadFetch: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  createProjectFileHandleFromValidatedPath: vi.fn(),
  tryCreateProjectFileHandle: vi.fn(),
  lookupAttachment: vi.fn(() => undefined),
}));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: loggerWarnMock, error: loggerErrorMock, debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

function makeRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'claude-code',
    projectDir: '/proj',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('command-handler session/subsession restart ack + error/sync parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replies with session.restart_response ok=false, session.error, and session_list on session.restart failure', async () => {
    const rec = makeRecord({ name: 'deck_proj_brain' });
    getSessionMock.mockReturnValue(rec);
    relaunchSessionWithSettingsMock.mockRejectedValueOnce(new Error('Cannot safely forward model "bad"'));
    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (m: Record<string, unknown>) => sent.push(m) };

    handleWebCommand({
      type: 'session.restart',
      requestId: 'req-main-1',
      sessionName: 'deck_proj_brain',
      agentType: 'claude-code',
      requestedModel: 'bad',
    }, serverLink as never);

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'session.restart_response',
        requestId: 'req-main-1',
        ok: false,
        rejected: true,
        error: 'Cannot safely forward model "bad"',
      });
    });

    expect(emitSessionInlineErrorMock).toHaveBeenCalledWith('deck_proj_brain', 'Cannot safely forward model "bad"');
    expect(sent).toContainEqual({
      type: 'session.error',
      project: 'proj',
      session: 'deck_proj_brain',
      sessionName: 'deck_proj_brain',
      message: 'Cannot safely forward model "bad"',
    });
    expect(buildSessionListMock).toHaveBeenCalled();
  });

  it('replies with subsession.restart_response ok=false, session.error, and sendSubSessionSync on subsession.restart failure', async () => {
    const rec = makeRecord({
      name: 'deck_sub_subwin1',
      role: 'w1',
      ccPreset: 'PrevPreset',
      requestedModel: null,
    });
    getSessionMock.mockReturnValue(rec);
    relaunchSessionWithSettingsMock.mockRejectedValueOnce(new Error('Cannot safely forward model "m %TEMP%"'));
    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (m: Record<string, unknown>) => sent.push(m) };

    handleWebCommand({
      type: 'subsession.restart',
      requestId: 'req-sub-1',
      sessionName: 'deck_sub_subwin1',
      agentType: 'claude-code',
      requestedModel: 'm %TEMP%',
    }, serverLink as never);

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'subsession.restart_response',
        requestId: 'req-sub-1',
        ok: false,
        rejected: true,
        error: 'Cannot safely forward model "m %TEMP%"',
      });
    });

    expect(emitSessionInlineErrorMock).toHaveBeenCalledWith('deck_sub_subwin1', 'Cannot safely forward model "m %TEMP%"');
    expect(sent).toContainEqual({
      type: 'session.error',
      project: 'proj',
      session: 'deck_sub_subwin1',
      sessionName: 'deck_sub_subwin1',
      message: 'Cannot safely forward model "m %TEMP%"',
    });
    expect(sendSubSessionSyncMock).toHaveBeenCalledWith(serverLink, 'subwin1', undefined, undefined);
  });

  it('replies with ok=true and carries previousRuntimeEpoch on successful session.restart and subsession.restart', async () => {
    const initial = makeRecord({ name: 'deck_sub_ok1', role: 'w1', runtimeEpoch: 'epoch-before-restart' });
    const after = makeRecord({ name: 'deck_sub_ok1', role: 'w1', agentType: 'claude-code', runtimeEpoch: 'epoch-after-restart' });
    getSessionMock.mockReturnValue(initial);
    relaunchSessionWithSettingsMock.mockImplementationOnce(async () => {
      getSessionMock.mockReturnValue(after);
    });
    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (m: Record<string, unknown>) => sent.push(m) };

    handleWebCommand({
      type: 'subsession.restart',
      requestId: 'req-sub-ok',
      sessionName: 'deck_sub_ok1',
      agentType: 'claude-code',
    }, serverLink as never);

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'subsession.restart_response',
        requestId: 'req-sub-ok',
        ok: true,
        previousRuntimeEpoch: 'epoch-before-restart',
        applied: expect.objectContaining({
          agentType: 'claude-code',
          ccPreset: null,
          requestedModel: null,
          activeModel: null,
          runtimeEpoch: 'epoch-after-restart',
        }),
      });
    });
  });

  it('returns actual daemon-applied fallback model (m1 instead of requested m2) with explicit nulls in restart_response', async () => {
    const initial = makeRecord({
      name: 'deck_sub_fallback1',
      role: 'w1',
      agentType: 'qwen',
      ccPreset: 'PresetA',
      requestedModel: 'm2',
      activeModel: 'm2',
      modelDisplay: 'm2',
    });
    const settled = makeRecord({
      name: 'deck_sub_fallback1',
      role: 'w1',
      agentType: 'qwen',
      ccPreset: 'PresetA',
      requestedModel: 'm1',
      activeModel: 'm1',
      modelDisplay: 'm1',
      runtimeEpoch: 'epoch-applied-1',
    });
    getSessionMock.mockReturnValueOnce(initial).mockReturnValueOnce(initial).mockReturnValue(settled);
    relaunchSessionWithSettingsMock.mockResolvedValueOnce(undefined);
    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (m: Record<string, unknown>) => sent.push(m) };

    handleWebCommand({
      type: 'subsession.restart',
      requestId: 'req-fallback-1',
      restartEpoch: 7,
      sessionName: 'deck_sub_fallback1',
      agentType: 'qwen',
      ccPreset: 'PresetA',
      requestedModel: 'm2',
    }, serverLink as never);

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'subsession.restart_response',
        requestId: 'req-fallback-1',
        ok: true,
        restartEpoch: 7,
        applied: expect.objectContaining({
          agentType: 'qwen',
          ccPreset: 'PresetA',
          requestedModel: 'm1',
          activeModel: 'm1',
          modelDisplay: 'm1',
          runtimeEpoch: 'epoch-applied-1',
        }),
      });
    });
  });

  it('aborts expired deadline before acquiring or inside relaunch lock without calling relaunchSessionWithSettings', async () => {
    const rec = makeRecord({ name: 'deck_sub_expired1', role: 'w1' });
    getSessionMock.mockReturnValue(rec);
    const sent: Array<Record<string, unknown>> = [];
    const serverLink = { send: (m: Record<string, unknown>) => sent.push(m) };

    handleWebCommand({
      type: 'subsession.restart',
      requestId: 'req-exp-1',
      restartEpoch: 4,
      deadlineAt: Date.now() - 10,
      sessionName: 'deck_sub_expired1',
      agentType: 'claude-code',
      ccPreset: null,
    }, serverLink as never);

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        type: 'subsession.restart_response',
        requestId: 'req-exp-1',
        ok: false,
        rejected: true,
        restartEpoch: 4,
        error: 'restart_timeout_before_start',
      });
    });
    expect(relaunchSessionWithSettingsMock).not.toHaveBeenCalled();
  });
});
