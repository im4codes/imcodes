import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COMPACTION_RESULT_EVENT } from '../../shared/compaction-events.js';

const {
  getSessionMock,
  stopTransportRuntimeSessionMock,
  launchTransportSessionMock,
  getTransportRuntimeMock,
  emitMock,
  buildSessionListMock,
  replayTransportHistoryMock,
  compressWithSdkMock,
  archiveEventsForMaterializationMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  stopTransportRuntimeSessionMock: vi.fn().mockResolvedValue(undefined),
  launchTransportSessionMock: vi.fn().mockResolvedValue(undefined),
  getTransportRuntimeMock: vi.fn(() => ({ providerSessionId: 'provider-session', send: vi.fn(), cancel: vi.fn() })),
  emitMock: vi.fn(),
  buildSessionListMock: vi.fn(async () => []),
  replayTransportHistoryMock: vi.fn(),
  compressWithSdkMock: vi.fn(),
  archiveEventsForMaterializationMock: vi.fn(),
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
  launchTransportSession: launchTransportSessionMock,
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: stopTransportRuntimeSessionMock,
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
vi.mock('../../src/daemon/transport-history.js', () => ({ replayTransportHistory: replayTransportHistoryMock }));
vi.mock('../../src/context/summary-compressor.js', () => ({
  compressWithSdk: compressWithSdkMock,
  // Default behavior covers any additional callers (e.g. proportional fallback
  // when manualCompactTargetTokens is the sentinel 0). Returns the same shape
  // as the real `computeTargetTokens(input, mode)`.
  computeTargetTokens: vi.fn((_input: number, mode: 'auto' | 'manual') => mode === 'manual' ? 800 : 500),
}));
vi.mock('../../src/context/tokenizer.js', () => ({ countTokens: vi.fn((text: string) => Math.max(1, Math.ceil(text.length / 4))) }));
vi.mock('../../src/context/memory-config.js', () => ({
  loadMemoryConfig: vi.fn(() => ({
    autoTriggerTokens: 3000,
    minEventCount: 5,
    idleMs: 300_000,
    scheduleMs: 900_000,
    maxBatchTokens: 10_000,
    autoMaterializationTargetTokens: 0,
    manualCompactTargetTokens: 800,
    maxEventChars: 4000,
    previousSummaryMaxTokens: 1200,
    masterIdleHours: 6,
    archiveRetentionDays: 30,
    extraRedactPatterns: [],
  })),
}));
vi.mock('../../src/context/compression-feedback.js', () => ({
  summarizeManualCompaction: vi.fn((input: { sourceEventIds: string[] }) => ({
    headline: 'Compressed',
    tokenLine: 'tokens',
    provenanceLine: 'sources',
    sourceEventIds: input.sourceEventIds,
  })),
}));
vi.mock('../../src/store/context-store.js', () => ({
  getProcessedProjectionStats: vi.fn(() => ({
    totalRecords: 0,
    matchedRecords: 0,
    recentSummaryCount: 0,
    durableCandidateCount: 0,
    projectCount: 0,
    stagedEventCount: 0,
    dirtyTargetCount: 0,
    pendingJobCount: 0,
  })),
  queryPendingContextEvents: vi.fn(() => []),
  queryProcessedProjections: vi.fn(() => []),
  recordMemoryHits: vi.fn(),
  archiveEventsForMaterialization: archiveEventsForMaterializationMock,
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

const flushAsync = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('transport /compact archive durability', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'idle',
      projectDir: '/proj',
      contextNamespace: { scope: 'personal', projectId: 'repo', userId: 'user-1' },
    });
    replayTransportHistoryMock.mockResolvedValue([
      { type: 'user.message', text: 'please compact this', _ts: 100 },
      { type: 'assistant.text', text: 'done compacting', _ts: 120 },
    ]);
    compressWithSdkMock.mockResolvedValue({
      summary: 'compact summary',
      model: 'test-model',
      backend: 'test',
      usedBackup: false,
      fromSdk: true,
    });
  });

  it('does not archive synthetic compact source rows when compression fails', async () => {
    compressWithSdkMock.mockRejectedValueOnce(new Error('compress unavailable'));

    handleWebCommand({ type: 'session.send', session: 'deck_proj_brain', text: '/compact', commandId: 'cmd-compact-fail' }, serverLink as any);
    await flushAsync();

    expect(archiveEventsForMaterializationMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_proj_brain',
      COMPACTION_RESULT_EVENT,
      expect.anything(),
      expect.anything(),
    );
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command.ack',
      commandId: 'cmd-compact-fail',
      status: 'error',
    }));
  });

  it('archives synthetic compact source rows only after successful relaunch/sync', async () => {
    handleWebCommand({ type: 'session.send', session: 'deck_proj_brain', text: '/compact', commandId: 'cmd-compact-ok' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_proj_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'deck_proj_brain', fresh: true }));
    expect(archiveEventsForMaterializationMock).toHaveBeenCalledTimes(1);
    const archivedEvents = archiveEventsForMaterializationMock.mock.calls[0][0];
    expect(archivedEvents.map((event: { id: string }) => event.id)).toEqual([
      expect.stringMatching(/^compact-src:deck_proj_brain:/),
      expect.stringMatching(/^compact-src:deck_proj_brain:/),
    ]);
    expect(emitMock).toHaveBeenCalledWith(
      'deck_proj_brain',
      COMPACTION_RESULT_EVENT,
      expect.objectContaining({ sourceEventIds: archivedEvents.map((event: { id: string }) => event.id) }),
      expect.objectContaining({ source: 'daemon' }),
    );
  });
});
