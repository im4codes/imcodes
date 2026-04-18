import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getSessionMock,
  getTransportRuntimeMock,
  emitMock,
  sendKeysDelayedEnterMock,
  searchLocalMemorySemanticMock,
  recordMemoryHitsMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  emitMock: vi.fn(),
  sendKeysDelayedEnterMock: vi.fn().mockResolvedValue(undefined),
  searchLocalMemorySemanticMock: vi.fn(),
  recordMemoryHitsMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
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
  recordMemoryHits: recordMemoryHitsMock,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: getTransportRuntimeMock,
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: sendKeysDelayedEnterMock,
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: vi.fn(() => vi.fn()),
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestSnapshot: vi.fn(),
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

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { resetAllRecentInjectionHistories } from '../../src/context/recent-injection-history.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('handleWebCommand memory context timeline', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetAllRecentInjectionHistories();
    setContextModelRuntimeConfig(null);
    getSessionMock.mockReturnValue({
      name: 'deck_process_brain',
      projectName: 'codedeck',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
    });
    emitMock.mockImplementation((sessionId: string, type: string, payload: Record<string, unknown>) => ({
      eventId: type === 'user.message' ? 'evt-user-1' : `evt-${type}`,
      sessionId,
      ts: 1000,
      seq: 1,
      epoch: 0,
      source: 'daemon',
      confidence: 'high',
      type,
      payload,
    }));
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [
        {
          id: 'mem-1',
          type: 'processed',
          projectId: 'codedeck',
          scope: 'personal',
          summary: 'Fix websocket reconnect loop',
          createdAt: 1,
          relevanceScore: 0.812,
          hitCount: 4,
          lastUsedAt: 1710000000000,
        },
      ],
      stats: {
        totalRecords: 1,
        matchedRecords: 1,
        recentSummaryCount: 1,
        durableCandidateCount: 0,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });
  });

  it('emits a linked memory.context event for injected related history', async () => {
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory',
    }, serverLink as any);

    await flushAsync();

    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith(
      'deck_process_brain',
      expect.stringContaining('[Related past work]'),
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        query: 'Fix reconnect issues in websocket client',
        injectedText: '[Related past work]\n<related-past-work advisory="true">\n- [codedeck] Fix websocket reconnect loop\n</related-past-work>',
        items: [
          expect.objectContaining({
            id: 'mem-1',
            projectId: 'codedeck',
            relevanceScore: 0.812,
            hitCount: 4,
            scope: 'personal',
          }),
        ],
      }),
    );
    expect(recordMemoryHitsMock).toHaveBeenCalledWith(['mem-1']);
    expect(recordMemoryHitsMock.mock.invocationCallOrder[0]).toBeGreaterThan(sendKeysDelayedEnterMock.mock.invocationCallOrder[0]);
  });

  it('applies the configured recall threshold when deciding whether to inject related history', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      memoryRecallMinScore: 0.44,
    });
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [
        {
          id: 'mem-threshold',
          type: 'processed',
          projectId: 'codedeck',
          scope: 'personal',
          summary: 'Mid-threshold multilingual semantic match',
          createdAt: 1,
          relevanceScore: 0.4446,
        },
      ],
      stats: {
        totalRecords: 1,
        matchedRecords: 1,
        recentSummaryCount: 1,
        durableCandidateCount: 0,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: '我感觉现在发的消息都没有相关历史recall了, 就像这句话 你自己测试下 不可能没有!',
      commandId: 'cmd-memory-threshold',
    }, serverLink as any);

    await flushAsync();

    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith(
      'deck_process_brain',
      expect.stringContaining('[Related past work]'),
      undefined,
    );
    expect(recordMemoryHitsMock).toHaveBeenCalledWith(['mem-threshold']);
  });

  it('does not increment recall hits when the process send fails before the linked memory card is emitted', async () => {
    sendKeysDelayedEnterMock.mockRejectedValueOnce(new Error('tmux failed'));

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory-fail',
    }, serverLink as any);

    await flushAsync();

    expect(recordMemoryHitsMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.anything(),
    );
  });

  it('emits a no-matches status when no related process memory is found', async () => {
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [],
      stats: {
        totalRecords: 0,
        matchedRecords: 0,
        recentSummaryCount: 0,
        durableCandidateCount: 0,
        projectCount: 0,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Investigate websocket reconnect behavior',
      commandId: 'cmd-memory-none',
    }, serverLink as any);

    await flushAsync();

    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'Investigate websocket reconnect behavior',
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        query: 'Investigate websocket reconnect behavior',
        status: 'no_matches',
        items: [],
      }),
    );
    expect(recordMemoryHitsMock).not.toHaveBeenCalled();
  });

  it('emits a recently-injected status when matches were found but all were filtered by recency', async () => {
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory-first',
    }, serverLink as any);
    await flushAsync();

    emitMock.mockClear();
    recordMemoryHitsMock.mockClear();

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory-second',
    }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        query: 'Fix reconnect issues in websocket client',
        status: 'deduped_recently',
        matchedCount: 1,
        dedupedCount: 1,
        items: [],
      }),
    );
    expect(recordMemoryHitsMock).not.toHaveBeenCalled();
  });

  it('emits a template-prompt skip status for built-in workflow prompts', async () => {
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Implement @openspec/changes/shared-agent-context and continue the template workflow',
      commandId: 'cmd-memory-template',
    }, serverLink as any);

    await flushAsync();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        status: 'skipped_template_prompt',
        items: [],
      }),
    );
  });
});
