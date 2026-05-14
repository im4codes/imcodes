import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import { TIMELINE_HISTORY_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_MESSAGES, TIMELINE_RESPONSE_STATUS, TIMELINE_RESPONSE_SOURCES } from '../../shared/timeline-protocol.js';

import { TimelinePreferredReadError } from '../../src/daemon/timeline-store.js';

const {
  getSessionMock,
  upsertSessionMock,
  readPreferredMock,
  readByTypesPreferredMock,
  exportOpenCodeSessionMock,
  buildTimelineEventsFromOpenCodeExportMock,
  buildSessionListMock,
  historyWorkerDispatchMock,
  shouldUseHistoryWorkerMock,
  TimelineHistoryPoolErrorMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  readPreferredMock: vi.fn(),
  readByTypesPreferredMock: vi.fn(),
  exportOpenCodeSessionMock: vi.fn(),
  buildTimelineEventsFromOpenCodeExportMock: vi.fn(),
  buildSessionListMock: vi.fn(async () => []),
  historyWorkerDispatchMock: vi.fn(),
  shouldUseHistoryWorkerMock: vi.fn(() => false),
  TimelineHistoryPoolErrorMock: class TimelineHistoryPoolErrorMock extends Error {
    readonly reason: string;

    constructor(reason: string) {
      super(reason);
      this.name = 'TimelineHistoryPoolError';
      this.reason = reason;
    }
  },
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
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
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
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn(), epoch: 99, replay: vi.fn(() => ({ events: [], truncated: false })) } }));

vi.mock('../../src/daemon/timeline-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/timeline-store.js')>();
  return {
    ...actual,
    timelineStore: {
      append: vi.fn(),
      read: vi.fn(() => []),
      readPreferred: readPreferredMock,
      readCompletedTextTail: vi.fn(),
      readByTypesPreferred: readByTypesPreferredMock,
      getLatest: vi.fn(() => null),
      getLatestPreferred: vi.fn(() => null),
      clear: vi.fn(),
    },
  };
});
vi.mock('../../src/daemon/timeline-history-pool.js', () => ({
  getDefaultTimelineHistoryWorkerPool: vi.fn(() => ({ dispatch: historyWorkerDispatchMock })),
  shouldUseTimelineHistoryWorkerPool: shouldUseHistoryWorkerMock,
  TimelineHistoryPoolError: TimelineHistoryPoolErrorMock,
}));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: buildSessionListMock }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));
vi.mock('../../src/daemon/opencode-history.js', () => ({
  exportOpenCodeSession: exportOpenCodeSessionMock,
  buildTimelineEventsFromOpenCodeExport: buildTimelineEventsFromOpenCodeExportMock,
  discoverLatestOpenCodeSessionId: vi.fn(),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('command-handler timeline history with SQLite-preferred reads', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    readPreferredMock.mockReset();
    readByTypesPreferredMock.mockReset();
    historyWorkerDispatchMock.mockReset();
    shouldUseHistoryWorkerMock.mockReset();
    shouldUseHistoryWorkerMock.mockReturnValue(false);
    getSessionMock.mockReturnValue(undefined);
    buildTimelineEventsFromOpenCodeExportMock.mockReturnValue([]);
    exportOpenCodeSessionMock.mockResolvedValue({});
  });

  it('uses the timeline history worker pool for regular non-OpenCode history requests', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ name: 'deck_worker', agentType: 'codex' });
    historyWorkerDispatchMock.mockResolvedValue({
      events: [
        { eventId: 'u-worker', sessionId: 'deck_worker', ts: 1010, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'from worker', detailRefs: [{ detailId: 'preview-only', eventId: 'u-worker', fieldPath: 'payload.text' }] } },
      ],
      detailCandidates: [
        {
          sessionName: 'deck_worker',
          epoch: 1,
          eventId: 'u-worker',
          fieldPath: 'payload.text',
          value: 'full worker detail',
          previewBytes: 1024,
          mediaType: 'text/plain',
        },
      ],
      eventsRead: 1,
      payloadBytes: 120,
      droppedEvents: 0,
      truncatedEvents: 0,
      readMs: 4,
      sanitizeMs: 1,
    });

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_worker',
      requestId: 'hist-worker',
      limit: 25,
      afterTs: 100,
      beforeTs: 200,
    }, serverLink as any);
    await flushAsync();

    expect(readByTypesPreferredMock).not.toHaveBeenCalled();
    expect(historyWorkerDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'deck_worker',
      limit: 25,
      afterTs: 100,
      beforeTs: 200,
      maxResponseBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE,
      contentTypes: expect.arrayContaining(['user.message', 'assistant.text', 'tool.result']),
      stateTypes: ['session.state'],
    }), expect.objectContaining({ deadlineAt: expect.any(Number) }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_worker',
      requestId: 'hist-worker',
      status: TIMELINE_RESPONSE_STATUS.OK,
      source: TIMELINE_RESPONSE_SOURCES.WORKER_SQLITE,
      payloadBytes: 120,
      payloadTruncated: false,
      events: [expect.objectContaining({ eventId: 'u-worker' })],
      detailRefs: [expect.objectContaining({
        sessionName: 'deck_worker',
        epoch: 1,
        detailStoreGeneration: expect.any(String),
        eventId: 'u-worker',
        fieldPath: 'payload.text',
      })],
    }));
  });

  it('keeps timeline.history under the default envelope when includeDetails is requested without an explicit larger budget', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ name: 'deck_worker', agentType: 'codex' });
    historyWorkerDispatchMock.mockResolvedValue({
      events: [],
      detailCandidates: [],
      eventsRead: 0,
      payloadBytes: 2,
      droppedEvents: 0,
      truncatedEvents: 0,
      readMs: 1,
      sanitizeMs: 0,
    });

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_worker',
      requestId: 'hist-include-details',
      includeDetails: true,
      limit: 300,
    }, serverLink as any);
    await flushAsync();

    expect(historyWorkerDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      maxResponseBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE,
    }), expect.objectContaining({ deadlineAt: expect.any(Number) }));
  });

  it('allows explicit full-history callers to request the larger page/detail budget', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ name: 'deck_worker', agentType: 'codex' });
    historyWorkerDispatchMock.mockResolvedValue({
      events: [],
      detailCandidates: [],
      eventsRead: 0,
      payloadBytes: 2,
      droppedEvents: 0,
      truncatedEvents: 0,
      readMs: 1,
      sanitizeMs: 0,
    });

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_worker',
      requestId: 'hist-explicit-full',
      includeDetails: true,
      budgetBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL,
      limit: 300,
    }, serverLink as any);
    await flushAsync();

    expect(historyWorkerDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      maxResponseBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL,
    }), expect.objectContaining({ deadlineAt: expect.any(Number) }));
  });

  it('falls back to the projection client when the history worker reports projection_unavailable', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ name: 'deck_fallback', agentType: 'codex' });
    historyWorkerDispatchMock.mockRejectedValue(new TimelineHistoryPoolErrorMock(
      TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
    ));
    readByTypesPreferredMock.mockImplementation(async (_session: string, types: string[]) => (
      types.includes('session.state')
        ? [
          { eventId: 's-fallback', sessionId: 'deck_fallback', ts: 1020, seq: 2, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'running' } },
        ]
        : [
          { eventId: 'u-fallback', sessionId: 'deck_fallback', ts: 1010, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'fallback' } },
        ]
    ));

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_fallback',
      requestId: 'hist-fallback',
      limit: 5,
    }, serverLink as any);
    await flushAsync();

    expect(historyWorkerDispatchMock).toHaveBeenCalledTimes(1);
    expect(readByTypesPreferredMock).toHaveBeenCalledTimes(2);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId: 'hist-fallback',
      status: TIMELINE_RESPONSE_STATUS.OK,
      source: TIMELINE_RESPONSE_SOURCES.MAIN_SQLITE,
      events: [
        expect.objectContaining({ eventId: 'u-fallback' }),
        expect.objectContaining({ eventId: 's-fallback' }),
      ],
    }));
  });

  it('uses type-filtered reads and preserves substantive budgeting plus session.state interleaving', async () => {
    readByTypesPreferredMock.mockImplementation(async (_session: string, types: string[]) => (
      types.includes('session.state')
        ? [
          { eventId: 's1', sessionId: 'deck_hist', ts: 1020, seq: 3, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'running' } },
        ]
        : [
          { eventId: 'u1', sessionId: 'deck_hist', ts: 1010, seq: 2, epoch: 1, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'hello' } },
          { eventId: 'a1', sessionId: 'deck_hist', ts: 1030, seq: 4, epoch: 1, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'world', streaming: false } },
        ]
    ));

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_hist',
      requestId: 'hist-1',
      limit: 2,
    }, serverLink as any);
    await flushAsync();

    expect(readByTypesPreferredMock).toHaveBeenCalledTimes(2);
    expect(readByTypesPreferredMock.mock.calls[0][0]).toBe('deck_hist');
    expect(readByTypesPreferredMock.mock.calls[0][2]).toEqual({ limit: 2, afterTs: undefined, beforeTs: undefined });
    expect(readByTypesPreferredMock.mock.calls[1][0]).toBe('deck_hist');
    expect(readByTypesPreferredMock.mock.calls[1][1]).toEqual(['session.state']);
    expect(readByTypesPreferredMock.mock.calls[1][2]).toEqual({ limit: 100, afterTs: 1009, beforeTs: undefined });
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_hist',
      requestId: 'hist-1',
      epoch: 99,
      status: TIMELINE_RESPONSE_STATUS.OK,
      events: [
        expect.objectContaining({ eventId: 'u1' }),
        expect.objectContaining({ eventId: 's1' }),
        expect.objectContaining({ eventId: 'a1' }),
      ],
    }));
  });

  it('honors timeline.page_request cursor and explicit page response budget', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ name: 'deck_page', agentType: 'codex' });
    historyWorkerDispatchMock.mockResolvedValue({
      events: [
        { eventId: 'page-older', sessionId: 'deck_page', ts: 900, seq: 9, epoch: 99, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'older', streaming: false } },
      ],
      eventsRead: 1,
      payloadBytes: 512,
      droppedEvents: 0,
      truncatedEvents: 0,
      readMs: 3,
      sanitizeMs: 1,
    });

    handleWebCommand({
      type: TIMELINE_MESSAGES.PAGE_REQUEST,
      sessionName: 'deck_page',
      requestId: 'page-1',
      limit: 50,
      budgetBytes: 2 * TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL,
      cursor: {
        epoch: 99,
        beforeTs: 1000,
        direction: 'older',
      },
    }, serverLink as any);
    await flushAsync();

    expect(historyWorkerDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'deck_page',
      limit: 50,
      beforeTs: 1000,
      maxResponseBytes: TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL,
    }), expect.objectContaining({ deadlineAt: expect.any(Number) }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.PAGE,
      sessionName: 'deck_page',
      requestId: 'page-1',
      status: TIMELINE_RESPONSE_STATUS.OK,
      source: TIMELINE_RESPONSE_SOURCES.WORKER_SQLITE,
      payloadBytes: 512,
      events: [expect.objectContaining({ eventId: 'page-older' })],
    }));
  });

  it('queries content types directly instead of over-reading state storms', async () => {
    readByTypesPreferredMock.mockImplementation(async (_session: string, types: string[]) => (
      types.includes('session.state')
        ? [
          { eventId: 's1', sessionId: 'deck_state_storm', ts: 1020, seq: 3, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'running' } },
        ]
        : [
          { eventId: 'u1', sessionId: 'deck_state_storm', ts: 1010, seq: 2, epoch: 1, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'hello' } },
          { eventId: 'a1', sessionId: 'deck_state_storm', ts: 1030, seq: 4, epoch: 1, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'world', streaming: false } },
        ]
    ));

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_state_storm',
      requestId: 'hist-state-storm',
      limit: 2,
    }, serverLink as any);
    await flushAsync();

    expect(readByTypesPreferredMock).toHaveBeenCalledTimes(2);
    expect(readByTypesPreferredMock.mock.calls[0][0]).toBe('deck_state_storm');
    expect(readByTypesPreferredMock.mock.calls[0][2]).toEqual({ limit: 2, afterTs: undefined, beforeTs: undefined });
    expect(readByTypesPreferredMock.mock.calls[1][0]).toBe('deck_state_storm');
    expect(readByTypesPreferredMock.mock.calls[1][1]).toEqual(['session.state']);
    expect(readByTypesPreferredMock.mock.calls[1][2]).toEqual({ limit: 100, afterTs: 1009, beforeTs: undefined });
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId: 'hist-state-storm',
      status: TIMELINE_RESPONSE_STATUS.OK,
      events: [
        expect.objectContaining({ eventId: 'u1' }),
        expect.objectContaining({ eventId: 's1' }),
        expect.objectContaining({ eventId: 'a1' }),
      ],
    }));
  });

  it('defers OpenCode initial history synthesis instead of exporting on the daemon main thread', async () => {
    readByTypesPreferredMock.mockImplementation(async (_session: string, types: string[]) => (
      types.includes('session.state')
        ? [{ eventId: 's0', sessionId: 'deck_oc_initial', ts: 1000, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'idle' } }]
        : []
    ));
    getSessionMock.mockReturnValue({
      name: 'deck_oc_initial',
      agentType: 'opencode',
      projectDir: '/tmp/project',
      opencodeSessionId: 'oc-1',
    });

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_oc_initial',
      requestId: 'hist-oc-initial',
      limit: 5,
    }, serverLink as any);
    await flushAsync();

    expect(exportOpenCodeSessionMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_oc_initial',
      requestId: 'hist-oc-initial',
      status: TIMELINE_RESPONSE_STATUS.DEFERRED,
      source: TIMELINE_RESPONSE_SOURCES.DEFERRED,
      errorReason: TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
      events: [],
    }));
  });

  it('keeps bounded OpenCode synthesis/replacement behavior for incremental history retrieval', async () => {
    readByTypesPreferredMock.mockImplementation(async (_session: string, types: string[]) => (
      types.includes('session.state')
        ? [{ eventId: 's0', sessionId: 'deck_oc', ts: 1000, seq: 1, epoch: 1, source: 'daemon', confidence: 'high', type: 'session.state', payload: { state: 'idle' } }]
        : []
    ));
    getSessionMock.mockReturnValue({
      name: 'deck_oc',
      agentType: 'opencode',
      projectDir: '/tmp/project',
      opencodeSessionId: 'oc-1',
    });
    buildTimelineEventsFromOpenCodeExportMock.mockReturnValue([
      { eventId: 'u1', sessionId: 'deck_oc', ts: 1010, seq: 1, epoch: 99, source: 'daemon', confidence: 'high', type: 'user.message', payload: { text: 'hi' } },
      { eventId: 'a1', sessionId: 'deck_oc', ts: 1020, seq: 2, epoch: 99, source: 'daemon', confidence: 'high', type: 'assistant.text', payload: { text: 'hello', streaming: false } },
    ]);

    handleWebCommand({
      type: 'timeline.history_request',
      sessionName: 'deck_oc',
      requestId: 'hist-oc',
      limit: 5,
      afterTs: 900,
    }, serverLink as any);
    await flushAsync();

    expect(readByTypesPreferredMock).toHaveBeenCalledWith('deck_oc', expect.arrayContaining(['user.message', 'assistant.text']), { limit: 5, afterTs: 900, beforeTs: undefined });
    expect(exportOpenCodeSessionMock).toHaveBeenCalledWith('/tmp/project', 'oc-1');
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_oc',
      requestId: 'hist-oc',
      status: TIMELINE_RESPONSE_STATUS.OK,
      source: TIMELINE_RESPONSE_SOURCES.OPENCODE_EXPORT,
      events: [
        expect.objectContaining({ eventId: 'u1' }),
        expect.objectContaining({ eventId: 'a1' }),
      ],
    }));
  });

  it('returns a terminal error response when the history worker queue is full', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ name: 'deck_queue_full', agentType: 'codex' });
    historyWorkerDispatchMock.mockRejectedValue(new TimelineHistoryPoolErrorMock(
      TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL,
    ));

    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_queue_full',
      requestId: 'hist-queue-full',
      limit: 5,
    }, serverLink as any);
    await flushAsync();

    expect(readByTypesPreferredMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_queue_full',
      requestId: 'hist-queue-full',
      status: TIMELINE_RESPONSE_STATUS.ERROR,
      errorReason: TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL,
      source: `worker_${TIMELINE_HISTORY_ERROR_REASONS.QUEUE_FULL}`,
      events: [],
      hasMore: false,
    }));
  });

  it('returns a terminal error response when the history worker times out', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    getSessionMock.mockReturnValue({ name: 'deck_worker_timeout', agentType: 'codex' });
    historyWorkerDispatchMock.mockRejectedValue(new TimelineHistoryPoolErrorMock(
      TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT,
    ));

    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_worker_timeout',
      requestId: 'hist-worker-timeout',
      limit: 5,
    }, serverLink as any);
    await flushAsync();

    expect(readByTypesPreferredMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_worker_timeout',
      requestId: 'hist-worker-timeout',
      status: TIMELINE_RESPONSE_STATUS.ERROR,
      errorReason: TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT,
      source: `worker_${TIMELINE_HISTORY_ERROR_REASONS.TIMEOUT}`,
      events: [],
      hasMore: false,
    }));
  });

  it('returns ERROR/projection_unavailable when the SQLite projection is unavailable — distinct from successful empty history', async () => {
    // Both return events:[], but only projection failure gets ERROR + errorReason
    getSessionMock.mockReturnValue({ name: 'deck_proj_unavail', agentType: 'codex' });
    shouldUseHistoryWorkerMock.mockReturnValue(false);
    readByTypesPreferredMock.mockRejectedValue(
      new TimelinePreferredReadError(
        TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
        'main_sqlite',
      ),
    );

    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_proj_unavail',
      requestId: 'hist-proj-unavail',
      limit: 50,
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_proj_unavail',
      requestId: 'hist-proj-unavail',
      status: TIMELINE_RESPONSE_STATUS.ERROR,
      errorReason: TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
      source: 'main_sqlite',
      events: [],
      hasMore: false,
    }));
  });

  it('returns OK/empty when there genuinely is no history — distinct from projection failure', async () => {
    getSessionMock.mockReturnValue({ name: 'deck_empty', agentType: 'codex' });
    shouldUseHistoryWorkerMock.mockReturnValue(false);
    // Both reads return empty arrays (no error thrown)
    readByTypesPreferredMock.mockResolvedValue([]);

    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_empty',
      requestId: 'hist-empty',
      limit: 50,
    }, serverLink as any);
    await flushAsync();

    // Successful empty history has status=OK, NO errorReason
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      sessionName: 'deck_empty',
      requestId: 'hist-empty',
      status: TIMELINE_RESPONSE_STATUS.OK,
      errorReason: undefined,
      events: [],
      hasMore: false,
    }));
  });
});
