import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const {
  listSessionsMock,
  getSessionMock,
  startProjectMock,
  teardownProjectMock,
  relaunchSessionWithSettingsMock,
  emitSessionInlineErrorMock,
  loggerWarnMock,
  loggerErrorMock,
  getDriverMock,
} = vi.hoisted(() => ({
  listSessionsMock: vi.fn<() => SessionRecord[]>(() => []),
  getSessionMock: vi.fn<() => SessionRecord | null>(() => null),
  startProjectMock: vi.fn().mockResolvedValue(undefined),
  teardownProjectMock: vi.fn().mockResolvedValue(undefined),
  relaunchSessionWithSettingsMock: vi.fn().mockResolvedValue(undefined),
  emitSessionInlineErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  getDriverMock: vi.fn(),
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
  startProject: startProjectMock,
  stopProject: vi.fn(),
  teardownProject: teardownProjectMock,
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: relaunchSessionWithSettingsMock,
  stopTransportRuntimeSession: vi.fn(),
  getDriver: getDriverMock,
}));

vi.mock('../../src/daemon/session-error.js', () => ({
  emitSessionInlineError: emitSessionInlineErrorMock,
}));

vi.mock('../../src/daemon/session-list.js', () => ({
  buildSessionList: vi.fn(async () => []),
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

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn(), readPreferred: vi.fn(async () => []) },
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

vi.mock('../../src/daemon/openspec-auto-deliver-orchestrator.js', () => ({
  handleOpenSpecAutoDeliverCommand: vi.fn(),
  getActiveOpenSpecAutoDeliverRunsBlockingDaemonUpgrade: vi.fn(() => []),
}));

vi.mock('../../src/daemon/repo-handler.js', () => ({
  handleRepoCommand: vi.fn(),
}));

vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileUploadFetch: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  createProjectFileHandleFromValidatedPath: vi.fn(),
  tryCreateProjectFileHandle: vi.fn(),
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

vi.mock('../../src/agent/codex-runtime-config.js', () => ({
  getCodexRuntimeConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../src/agent/codex-display.js', () => ({
  mergeCodexDisplayMetadata: vi.fn(() => ({})),
}));
vi.mock('../../src/agent/sdk-runtime-config.js', () => ({
  getClaudeSdkRuntimeConfig: vi.fn().mockResolvedValue({}),
  normalizeClaudeSdkModelForProvider: vi.fn((m: unknown) => m),
}));
vi.mock('../../src/agent/provider-display.js', () => ({
  getQwenDisplayMetadata: vi.fn(() => ({})),
}));
vi.mock('../../src/agent/provider-quota.js', () => ({
  getQwenOAuthQuotaUsageLabel: vi.fn(() => undefined),
  recordQwenOAuthRequest: vi.fn(),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

function makeRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_cd_brain',
    projectName: 'cd',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/proj/cd',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('handleRestart project & unsupported-agent protections', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes sub-sessions and skips removed workers on project restart while preserving worker order', async () => {
    listSessionsMock.mockReturnValue([
      makeRecord({ name: 'deck_cd_brain', role: 'brain', agentType: 'codex-sdk' }),
      makeRecord({ name: 'deck_cd_w10', role: 'w10', agentType: 'claude-code' }),
      makeRecord({ name: 'deck_cd_w2', role: 'w2', agentType: 'gemini' as SessionRecord['agentType'] }),
      makeRecord({ name: 'deck_cd_w1', role: 'w1', agentType: 'codex' }),
      makeRecord({
        name: 'deck_sub_sup_auto_cf1b33349f12b0e5',
        role: 'w1',
        agentType: 'gemini-sdk' as SessionRecord['agentType'],
        parentSession: 'deck_cd_brain',
      }),
      makeRecord({
        name: 'deck_sub_worker_alive',
        role: 'w1',
        agentType: 'codex-sdk',
        parentSession: 'deck_cd_brain',
      }),
    ]);

    await handleWebCommand({ type: 'session.restart', project: 'cd', fresh: false }, serverLink as never);

    expect(teardownProjectMock).toHaveBeenCalledWith('cd');
    expect(startProjectMock).toHaveBeenCalledWith({
      name: 'cd',
      dir: '/proj/cd',
      brainType: 'codex-sdk',
      workerTypes: ['codex', 'claude-code'],
      fresh: false,
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'cd', sessionName: 'deck_cd_w2', agentType: 'gemini' }),
      'session.restart: skipping worker with unsupported or removed agent type',
    );
    expect(emitSessionInlineErrorMock).not.toHaveBeenCalled();
    expect(getDriverMock).not.toHaveBeenCalled();
  });

  it('fails fast before teardown when project brain uses a removed agentType', async () => {
    listSessionsMock.mockReturnValue([
      makeRecord({ name: 'deck_cd_brain', role: 'brain', agentType: 'gemini-sdk' as SessionRecord['agentType'] }),
      makeRecord({ name: 'deck_cd_w1', role: 'w1', agentType: 'codex' }),
    ]);

    await handleWebCommand({ type: 'session.restart', project: 'cd', fresh: true }, serverLink as never);

    expect(teardownProjectMock).not.toHaveBeenCalled();
    expect(startProjectMock).not.toHaveBeenCalled();
    expect(emitSessionInlineErrorMock).toHaveBeenCalledWith(
      'deck_cd_brain',
      expect.stringContaining("Unsupported or removed agent type 'gemini-sdk'"),
    );
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.error',
      project: 'cd',
      message: expect.stringContaining("Unsupported or removed agent type 'gemini-sdk'"),
    }));
  });

  it('allows single-session restart switching FROM legacy gemini-sdk TO supported agy-sdk', async () => {
    const legacy = makeRecord({
      name: 'deck_cd_w2',
      role: 'w2',
      agentType: 'gemini-sdk' as SessionRecord['agentType'],
      runtimeType: 'transport',
    });
    getSessionMock.mockReturnValue(legacy);

    await handleWebCommand({
      type: 'session.restart',
      sessionName: 'deck_cd_w2',
      agentType: 'agy-sdk',
    }, serverLink as never);

    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledWith(legacy, expect.objectContaining({
      agentType: 'agy-sdk',
    }));
    expect(emitSessionInlineErrorMock).not.toHaveBeenCalled();
  });
});
