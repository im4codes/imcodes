import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPACT_HIJACK_CONTINUATION_PROMPT,
  COMPACT_HIJACK_MSG,
} from '../../shared/compact-hijack.js';

const {
  getSessionMock,
  upsertSessionMock,
  relaunchSessionWithSettingsMock,
  getTransportRuntimeMock,
  emitMock,
  buildSessionListMock,
  runtimeSendMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  relaunchSessionWithSettingsMock: vi.fn().mockResolvedValue(undefined),
  getTransportRuntimeMock: vi.fn(),
  emitMock: vi.fn(),
  buildSessionListMock: vi.fn(async () => []),
  runtimeSendMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: upsertSessionMock,
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/session-manager.js')>();
  return {
    ...actual,
    startProject: vi.fn(),
    stopProject: vi.fn(),
    teardownProject: vi.fn(),
    getTransportRuntime: getTransportRuntimeMock,
    launchTransportSession: vi.fn(),
    isProviderSessionBound: vi.fn(() => false),
    persistSessionRecord: vi.fn(),
    relaunchSessionWithSettings: relaunchSessionWithSettingsMock,
    stopTransportRuntimeSession: vi.fn(),
  };
});

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
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));

import {
  handleWebCommand,
  triggerCompactHijackForSession,
} from '../../src/daemon/command-handler.js';
import {
  getPersistedCompactHijackGlobalConfig,
  isGlobalCompactHijackEnabled,
  resetCompactHijackConfigStoreForTests,
} from '../../src/store/compact-hijack-config-store.js';
import {
  canTriggerCompactHijackForSession,
  finishCompactHijackSlot,
  resetCompactHijackStateForTests,
  tryAcquireCompactHijackSlot,
} from '../../src/agent/session-manager.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

describe('daemon command-handler compact hijack integration', () => {
  let tmpDir: string;
  const prevEnv = process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH;
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'imc-ch-cmd-'));
    process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH = join(tmpDir, 'compact-hijack.json');
    resetCompactHijackConfigStoreForTests();
    resetCompactHijackStateForTests();
    vi.clearAllMocks();
    relaunchSessionWithSettingsMock.mockResolvedValue(undefined);
    getTransportRuntimeMock.mockReturnValue({ send: runtimeSendMock });
  });

  afterEach(() => {
    resetCompactHijackStateForTests();
    resetCompactHijackConfigStoreForTests();
    if (prevEnv === undefined) delete process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH;
    else process.env.IMCODES_COMPACT_HIJACK_CONFIG_PATH = prevEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies compact_hijack.apply and rejects spoofed sharedActor apply', () => {
    expect(isGlobalCompactHijackEnabled()).toBe(false);

    handleWebCommand({
      type: COMPACT_HIJACK_MSG.APPLY,
      enabled: true,
      sharedActor: { shareId: 'sh-1' },
    }, serverLink as never);
    expect(isGlobalCompactHijackEnabled()).toBe(false);

    handleWebCommand({
      type: COMPACT_HIJACK_MSG.APPLY,
      enabled: true,
    }, serverLink as never);
    expect(isGlobalCompactHijackEnabled()).toBe(true);
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({ enabled: true });

    handleWebCommand({
      type: COMPACT_HIJACK_MSG.APPLY,
      enabled: true,
      handoffTextLimit: 45,
      handoffSummaryLimit: 8,
      handoffMaxChars: 64_000,
    }, serverLink as never);
    expect(getPersistedCompactHijackGlobalConfig()).toEqual({
      enabled: true,
      handoffTextLimit: 45,
      handoffSummaryLimit: 8,
      handoffMaxChars: 64_000,
    });
  });

  it('blocks sharedActor transportConfig changes to compactHijack while preserving owner setting', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      transportConfig: {
        compactHijack: 'on',
        handoffTextLimit: 55,
        handoffSummaryLimit: 5,
        handoffMaxChars: 50_000,
        uiLocale: 'zh-CN',
      },
    });

    // Shared caller attempting to change compactHijack or Handoff limits directly is ignored
    handleWebCommand({
      type: 'session.update_transport_config',
      sessionName: 'deck_proj_brain',
      transportConfig: { compactHijack: 'off' },
      sharedActor: { shareId: 'sh-1' },
    }, serverLink as never);
    handleWebCommand({
      type: 'session.update_transport_config',
      sessionName: 'deck_proj_brain',
      transportConfig: { handoffTextLimit: 10 },
      sharedActor: { shareId: 'sh-1' },
    }, serverLink as never);
    await flush();
    expect(upsertSessionMock).not.toHaveBeenCalled();

    // Shared caller changing uiLocale preserves owner compactHijack & Handoff limits
    handleWebCommand({
      type: 'session.update_transport_config',
      sessionName: 'deck_proj_brain',
      transportConfig: { uiLocale: 'en' },
      sharedActor: { shareId: 'sh-1' },
    }, serverLink as never);
    await flush();
    expect(upsertSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transportConfig: {
          uiLocale: 'en',
          compactHijack: 'on',
          handoffTextLimit: 55,
          handoffSummaryLimit: 5,
          handoffMaxChars: 50_000,
        },
      }),
    );
  });

  it('executes /handoff relaunch + sends exact continuation prompt for enabled owned session, and enforces cooldown & incognito exemption', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      projectDir: '/tmp/proj',
      sessionInstanceId: 'inst-1',
      transportConfig: { compactHijack: 'on' },
    });

    await triggerCompactHijackForSession('deck_proj_brain', serverLink as never, { reason: 'status' });

    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deck_proj_brain' }),
      { fresh: true, handoff: true },
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_brain',
      'user.message',
      expect.objectContaining({ text: COMPACT_HIJACK_CONTINUATION_PROMPT }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(runtimeSendMock).toHaveBeenCalledWith(
      COMPACT_HIJACK_CONTINUATION_PROMPT,
      expect.stringMatching(/^compact-hijack-/),
    );

    // Cooldown prevents immediate re-trigger within 30s
    const t0 = 1_000_000;
    expect(tryAcquireCompactHijackSlot('deck_proj_brain', t0)).toBe(true);
    expect(tryAcquireCompactHijackSlot('deck_proj_brain', t0 + 100)).toBe(false);
    finishCompactHijackSlot('deck_proj_brain', true, t0);
    expect(canTriggerCompactHijackForSession('deck_proj_brain', t0 + 15_000)).toBe(false);
    expect(canTriggerCompactHijackForSession('deck_proj_brain', t0 + 30_000)).toBe(true);

    // Incognito never triggers
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({
      name: 'deck_proj_incog',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      incognito: true,
      transportConfig: { compactHijack: 'on' },
    });
    expect(canTriggerCompactHijackForSession('deck_proj_incog', t0 + 30_000)).toBe(false);
    await triggerCompactHijackForSession('deck_proj_incog', serverLink as never);
    expect(relaunchSessionWithSettingsMock).not.toHaveBeenCalled();
  });

  it('auto-dispatches continuation once after user /handoff on a transport session', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_proj_handoff',
      projectName: 'proj',
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      projectDir: '/tmp/proj',
      state: 'idle',
      sessionInstanceId: 'inst-handoff-1',
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_handoff',
      text: '/handoff',
      commandId: 'cmd-user-handoff-1',
    }, serverLink as never);
    await flush();
    await flush();

    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deck_proj_handoff' }),
      { fresh: true, handoff: true },
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_handoff',
      'user.message',
      expect.objectContaining({
        text: COMPACT_HIJACK_CONTINUATION_PROMPT,
        clientMessageId: expect.stringMatching(/^handoff-/),
      }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(runtimeSendMock).toHaveBeenCalledTimes(1);
    expect(runtimeSendMock).toHaveBeenCalledWith(
      COMPACT_HIJACK_CONTINUATION_PROMPT,
      expect.stringMatching(/^handoff-/),
    );
  });
});
