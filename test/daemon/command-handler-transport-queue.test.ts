import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID } from '../../shared/ack-protocol.js';
import { TRANSPORT_SESSION_AGENT_TYPES } from '../../shared/agent-types.js';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import {
  SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
  SESSION_CONTROL_TIMELINE_STATE_STOPPING,
} from '../../shared/session-control-commands.js';
import {
  MEMORY_MCP_PROVIDER_ID,
  MEMORY_MCP_PROVIDER_IDS,
  MEMORY_MCP_PROVIDER_STATUS_REASON,
  MEMORY_MCP_STATUS,
  MEMORY_MCP_TOOL_FAMILY,
  MEMORY_WS,
} from '../../shared/memory-ws.js';
import { MEMORY_MANAGEMENT_CONTEXT_FIELD } from '../../shared/memory-management-context.js';
import { MEMORY_MANAGEMENT_ERROR_CODES } from '../../shared/memory-management.js';
import { MEMORY_FEATURE_CONFIG_MSG, MEMORY_FEATURE_FLAGS_BY_NAME, memoryFeatureFlagEnvKey } from '../../shared/feature-flags.js';
import {
  MEMORY_MCP_DISABLED_FLAGS,
  MEMORY_MCP_TOOL_NAMES,
} from '../../shared/memory-mcp-contracts.js';
import { TIMELINE_DETAIL_ERROR_REASONS, TIMELINE_REQUEST_ERROR_REASONS } from '../../shared/timeline-history-errors.js';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import {
  PREFERENCE_CONTEXT_START,
  PREFERENCE_FEATURE_ENV_KEY,
  PREFERENCE_IDEMPOTENCY_PREFIX,
  PREFERENCE_INGEST_OBSERVATION_CLASS,
  PREFERENCE_INGEST_OBSERVATION_STATE,
  PREFERENCE_INGEST_ORIGIN,
  PREFERENCE_INGEST_SCOPE,
} from '../../shared/preference-ingest.js';
import { TIMELINE_CURSOR_DIRECTIONS, TIMELINE_MESSAGES, TIMELINE_RESPONSE_STATUS, TIMELINE_RESPONSE_SOURCES } from '../../shared/timeline-protocol.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import { resetMemoryFeatureConfigStoreForTests } from '../../src/store/memory-feature-config-store.js';

const {
  getSessionMock,
  upsertSessionMock,
  getTransportRuntimeMock,
  emitMock,
  launchTransportSessionMock,
  relaunchSessionWithSettingsMock,
  stopTransportRuntimeSessionMock,
  resizeSessionMock,
  terminalSubscribeMock,
  terminalRequestSnapshotMock,
  supervisionDecideMock,
  queueTaskIntentMock,
  registerTaskIntentMock,
  applySnapshotUpdateMock,
  updateQueuedTaskIntentMock,
  removeQueuedTaskIntentMock,
  getQwenRuntimeConfigMock,
  searchLocalMemoryMock,
  searchLocalMemoryAuthorizedMock,
  searchLocalMemorySemanticMock,
  getProcessedProjectionStatsMock,
  queryPendingContextEventsMock,
  queryProcessedProjectionsMock,
  recordMemoryHitsMock,
  listContextObservationsMock,
  deleteContextObservationMock,
  ensureContextNamespaceMock,
  promoteContextObservationMock,
  writeContextObservationMock,
  historyWorkerDispatchMock,
  shouldUseHistoryWorkerMock,
  getProviderMock,
  ensureProviderConnectedMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  upsertSessionMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  emitMock: vi.fn(),
  launchTransportSessionMock: vi.fn().mockResolvedValue(undefined),
  relaunchSessionWithSettingsMock: vi.fn(),
  stopTransportRuntimeSessionMock: vi.fn().mockResolvedValue(undefined),
  resizeSessionMock: vi.fn(),
  terminalSubscribeMock: vi.fn(() => vi.fn()),
  terminalRequestSnapshotMock: vi.fn(),
  supervisionDecideMock: vi.fn(async () => ({ decision: 'complete', reason: 'ok', confidence: 0.9 })),
  queueTaskIntentMock: vi.fn(),
  registerTaskIntentMock: vi.fn(),
  applySnapshotUpdateMock: vi.fn(),
  updateQueuedTaskIntentMock: vi.fn(),
  removeQueuedTaskIntentMock: vi.fn(),
  getQwenRuntimeConfigMock: vi.fn().mockResolvedValue({}),
  searchLocalMemoryMock: vi.fn(),
  searchLocalMemoryAuthorizedMock: vi.fn(),
  searchLocalMemorySemanticMock: vi.fn(),
  getProcessedProjectionStatsMock: vi.fn(() => ({
    totalRecords: 0,
    matchedRecords: 0,
    recentSummaryCount: 0,
    durableCandidateCount: 0,
    projectCount: 0,
    stagedEventCount: 0,
    dirtyTargetCount: 0,
    pendingJobCount: 0,
  })),
  queryPendingContextEventsMock: vi.fn(() => []),
  queryProcessedProjectionsMock: vi.fn(() => []),
  recordMemoryHitsMock: vi.fn(),
  listContextObservationsMock: vi.fn(() => []),
  deleteContextObservationMock: vi.fn(() => true),
  ensureContextNamespaceMock: vi.fn(() => ({
    id: 'pref-namespace',
    key: 'pref-key',
    localTenant: 'daemon-local',
    visibility: 'private',
    createdAt: 1,
    updatedAt: 1,
  })),
  promoteContextObservationMock: vi.fn(() => ({ id: 'audit-1', observationId: 'obs-1', action: 'web_ui_promote' })),
  writeContextObservationMock: vi.fn(),
  historyWorkerDispatchMock: vi.fn(),
  shouldUseHistoryWorkerMock: vi.fn(() => false),
  getProviderMock: vi.fn(),
  ensureProviderConnectedMock: vi.fn(),
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
  getTransportRuntime: getTransportRuntimeMock,
  launchTransportSession: launchTransportSessionMock,
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: relaunchSessionWithSettingsMock,
  stopTransportRuntimeSession: stopTransportRuntimeSessionMock,
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: resizeSessionMock,
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: terminalSubscribeMock,
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestSnapshot: terminalRequestSnapshotMock,
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
    readPreferred: vi.fn(() => Promise.resolve([])),
    readByTypesPreferred: vi.fn(() => []),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-history-pool.js', () => ({
  getDefaultTimelineHistoryWorkerPool: vi.fn(() => ({ dispatch: historyWorkerDispatchMock })),
  shouldUseTimelineHistoryWorkerPool: shouldUseHistoryWorkerMock,
  TimelineHistoryPoolError: class TimelineHistoryPoolError extends Error {
    readonly reason: string;

    constructor(reason: string) {
      super(reason);
      this.reason = reason;
    }
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

vi.mock('../../src/agent/qwen-runtime-config.js', () => ({
  getQwenRuntimeConfig: getQwenRuntimeConfigMock,
}));

vi.mock('../../src/agent/provider-registry.js', () => ({
  getProvider: getProviderMock,
  ensureProviderConnected: ensureProviderConnectedMock,
}));

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: searchLocalMemoryMock,
  searchLocalMemoryAuthorized: searchLocalMemoryAuthorizedMock,
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

vi.mock('../../src/store/context-store.js', () => ({
  deleteContextObservation: deleteContextObservationMock,
  getProcessedProjectionStats: getProcessedProjectionStatsMock,
  queryPendingContextEvents: queryPendingContextEventsMock,
  queryProcessedProjections: queryProcessedProjectionsMock,
  recordMemoryHits: recordMemoryHitsMock,
  listContextObservations: listContextObservationsMock,
  ensureContextNamespace: ensureContextNamespaceMock,
  promoteContextObservation: promoteContextObservationMock,
  writeContextObservation: writeContextObservationMock,
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

vi.mock('../../src/daemon/supervision-broker.js', () => ({
  supervisionBroker: {
    decide: supervisionDecideMock,
  },
}));

vi.mock('../../src/daemon/supervision-automation.js', () => ({
  supervisionAutomation: {
    init: vi.fn(),
    setServerLink: vi.fn(),
    cancelSession: vi.fn(),
    queueTaskIntent: queueTaskIntentMock,
    registerTaskIntent: registerTaskIntentMock,
    applySnapshotUpdate: applySnapshotUpdateMock,
    updateQueuedTaskIntent: updateQueuedTaskIntentMock,
    removeQueuedTaskIntent: removeQueuedTaskIntentMock,
  },
}));

import {
  handleWebCommand,
  __invalidateTransportListModelsCacheForTests,
  __resetTransportListModelsCacheForTests,
  __resolveTransportListModelsCacheTtlMsForTests,
} from '../../src/daemon/command-handler.js';
import { getDefaultTimelineDetailStore } from '../../src/daemon/timeline-detail-store.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function timelineEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt',
    sessionId: 'deck_transport_brain',
    ts: 1,
    seq: 1,
    epoch: 0,
    source: 'daemon',
    confidence: 'high',
    type: 'tool.result',
    payload: {},
    ...overrides,
  };
}

function enableMemoryFoundationFlags(): void {
  vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry), '1');
  vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.observationStore), '1');
}

function enablePreferenceFeature(): void {
  enableMemoryFoundationFlags();
  vi.stubEnv(PREFERENCE_FEATURE_ENV_KEY, '1');
}

function enableMdIngestFeature(): void {
  enableMemoryFoundationFlags();
  vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest), '1');
}

function localMemoryManagementContext() {
  return {
    actorId: 'operator-1',
    userId: 'operator-1',
    role: 'user',
    source: 'local_daemon',
  };
}

function makeRuntimeProvider(sendImpl: ReturnType<typeof vi.fn>): TransportProvider {
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: { code: string; message: string; recoverable: boolean }) => void) | null = null;
  return {
    id: 'mock-sdk',
    connectionMode: 'persistent',
    sessionOwnership: 'provider',
    capabilities: {
      streaming: true,
      toolCalling: false,
      approval: false,
      sessionRestore: false,
      multiTurn: true,
      attachments: false,
      contextSupport: 'full-normalized-context-injection',
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    createSession: vi.fn().mockResolvedValue('sess-1'),
    endSession: vi.fn(),
    send: sendImpl,
    cancel: vi.fn(),
    onDelta: (cb: (sid: string, d: MessageDelta) => void) => {
      deltaCb = cb;
      return () => { deltaCb = null; };
    },
    onComplete: (cb: (sid: string, m: AgentMessage) => void) => {
      completeCb = cb;
      return () => { completeCb = null; };
    },
    onError: (cb: (sid: string, e: { code: string; message: string; recoverable: boolean }) => void) => {
      errorCb = cb;
      return () => { errorCb = null; };
    },
    onApprovalRequest: vi.fn(),
    respondApproval: vi.fn().mockResolvedValue(undefined),
    // Keep callbacks referenced so TypeScript doesn't collapse the closure in
    // tests; this provider is only used for send-start/recall timing.
    __testCallbacks: { deltaCb, completeCb, errorCb },
  } as unknown as TransportProvider;
}

function emptyMemorySearchResult() {
  return {
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
  };
}

function firstInvocationOrder(matcher: (call: unknown[]) => boolean): number {
  const index = emitMock.mock.calls.findIndex((call) => matcher(call));
  if (index < 0) return Number.POSITIVE_INFINITY;
  return emitMock.mock.invocationCallOrder[index] ?? Number.POSITIVE_INFINITY;
}

describe('handleWebCommand transport queue behavior', () => {
  let memoryFeatureConfigTempDir: string | null = null;
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    serverLink.send.mockReset();
    serverLink.sendBinary.mockReset();
    serverLink.sendTimelineEvent.mockReset();
    memoryFeatureConfigTempDir = mkdtempSync(join(tmpdir(), 'imcodes-memory-feature-flags-'));
    vi.stubEnv('IMCODES_MEMORY_FEATURE_CONFIG_PATH', join(memoryFeatureConfigTempDir, 'feature-flags.json'));
    resetMemoryFeatureConfigStoreForTests();
    supervisionDecideMock.mockResolvedValue({ decision: 'complete', reason: 'ok', confidence: 0.9 });
    getQwenRuntimeConfigMock.mockResolvedValue({});
    historyWorkerDispatchMock.mockReset();
    shouldUseHistoryWorkerMock.mockReset();
    shouldUseHistoryWorkerMock.mockReturnValue(false);
    getProviderMock.mockReset();
    ensureProviderConnectedMock.mockReset();
    __resetTransportListModelsCacheForTests();
    getDefaultTimelineDetailStore().clear();
    searchLocalMemoryMock.mockResolvedValue(emptyMemorySearchResult());
    searchLocalMemoryAuthorizedMock.mockReturnValue(emptyMemorySearchResult());
    searchLocalMemorySemanticMock.mockResolvedValue(emptyMemorySearchResult());
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
    });
  });

  afterEach(() => {
    resetMemoryFeatureConfigStoreForTests();
    vi.unstubAllEnvs();
    if (memoryFeatureConfigTempDir) {
      rmSync(memoryFeatureConfigTempDir, { recursive: true, force: true });
      memoryFeatureConfigTempDir = null;
    }
  });

  // ── F4 regression suite (audit f395d49c-78c) ─────────────────────────────
  //
  // Before this fix, `handleSend` read `record = getSession(sessionName)` and
  // computed `isTransportSession` via `record?.runtimeType === 'transport' ||
  // (typeof record?.agentType === 'string' && isTransportAgent(...))`. When
  // record was undefined, both clauses evaluated to false, the
  // `!transportRuntime && isTransportSession` guard at line 2929 was skipped,
  // and the message silently fell through to the process-agent / tmux path
  // around line 3380+. `sendProcessSessionMessage` then ran with
  // `agentType='unknown'` and tried to `sendKeys` to a tmux session that did
  // not exist; the failure was only logged, never surfaced. The client saw
  // an "accepted" command.ack while the message reached no backend.
  //
  // For `transportRuntime && !providerSessionId && !record` it was worse:
  // `enqueueResend` + `emitAcceptedReceiptAck` ran, but `if (record)` guarded
  // the relaunch dispatch, so the message was accepted into a queue with no
  // scheduled recovery.
  //
  // T3/T4 lock the fail-closed contract: any record-missing session.send
  // emits an explicit error ack, does NOT enqueue, does NOT invoke any
  // process-agent / tmux path, and does NOT trigger a relaunch.

  it('T3: handleSend with record=undefined (no runtime) emits session_missing error and does NOT fallthrough to process-agent / enqueue / launch', async () => {
    // Override default beforeEach record return — simulate a session that
    // was concurrently deleted (e.g. clone teardown race) or whose store
    // entry was lost.
    //
    // Protocol note: the early `emitAcceptedReceiptAck()` at command-handler
    // line ~2530 is a daemon-receipt ack ("daemon got your command", per
    // CLAUDE.md transport command liveness contract) and runs BEFORE the
    // F4 guard. The fail-closed error ack from F4 then signals "but
    // delivery failed". This dual-ack pattern is intentional and
    // documented; the web client treats the later error ack as the
    // authoritative outcome.
    getSessionMock.mockReturnValue(undefined);
    getTransportRuntimeMock.mockReturnValue(undefined);

    handleWebCommand(
      { type: 'session.send', session: 'deck_missing_brain', text: 'hello', commandId: 'cmd-missing-1' },
      serverLink as any,
    );
    await flushAsync();

    // The F4 outcome ack carries error=session_missing.
    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'command.ack',
        commandId: 'cmd-missing-1',
        session: 'deck_missing_brain',
        status: 'error',
        error: 'session_missing',
      }),
    );

    // session.state error was broadcast (UI surfaces the failure).
    expect(emitMock).toHaveBeenCalledWith(
      'deck_missing_brain',
      'session.state',
      expect.objectContaining({ state: 'error', error: 'session_missing' }),
      expect.any(Object),
    );

    // No user.message was emitted (message never reached any backend).
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_missing_brain',
      'user.message',
      expect.anything(),
      expect.anything(),
    );

    // No transport relaunch / launch attempt — F4 prevents accepted-without-dispatch.
    expect(launchTransportSessionMock).not.toHaveBeenCalled();
  });

  it('T4: handleSend with record=undefined AND runtime+null providerSessionId still emits session_missing error (no accepted-without-relaunch)', async () => {
    // This is the second F4 path: a stale runtime entry without a provider
    // session id can occur after a partial relaunch. Pre-fix behaviour:
    // `enqueueResend` + `emitAcceptedReceiptAck` ran, but `if (record)`
    // skipped relaunch — message landed in resend queue with no scheduled
    // recovery.
    const runtimeSendMock = vi.fn();
    getSessionMock.mockReturnValue(undefined);
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: null,
      send: runtimeSendMock,
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });

    handleWebCommand(
      { type: 'session.send', session: 'deck_missing_brain', text: 'hello again', commandId: 'cmd-missing-2' },
      serverLink as any,
    );
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'command.ack',
        commandId: 'cmd-missing-2',
        status: 'error',
        error: 'session_missing',
      }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_missing_brain',
      'session.state',
      expect.objectContaining({ state: 'error', error: 'session_missing' }),
      expect.any(Object),
    );
    // Critically: no relaunch attempted (the bug previously skipped this).
    expect(launchTransportSessionMock).not.toHaveBeenCalled();
    // Critically: runtime.send never reached.
    expect(runtimeSendMock).not.toHaveBeenCalled();
  });

  it('emits queued session.state for queued transport sends without adding a timeline row', async () => {
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: vi.fn(() => 'queued'),
      pendingCount: 2,
      pendingMessages: ['queued msg', 'queued msg 2'],
      pendingEntries: [
        { clientMessageId: 'cmd-queued', text: 'queued msg' },
        { clientMessageId: 'cmd-queued-2', text: 'queued msg 2' },
      ],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'queued msg', commandId: 'cmd-queued' }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      {
        state: 'queued',
        pendingCount: 2,
        pendingMessages: ['queued msg', 'queued msg 2'],
        pendingMessageEntries: [
          { clientMessageId: 'cmd-queued', text: 'queued msg' },
          { clientMessageId: 'cmd-queued-2', text: 'queued msg 2' },
        ],
      },
      expect.any(Object),
    );
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.objectContaining({ clientMessageId: 'cmd-queued', pending: true }),
      expect.anything(),
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-queued', status: 'accepted' });
  });

  it('dispatches /clear as a fresh claude-code-sdk relaunch', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      label: 'Brain',
      description: 'desc',
      requestedModel: 'sonnet',
      effort: 'high',
      transportConfig: { supervision: { mode: 'off' } },
      ccPreset: 'preset-a',
      ccSessionId: 'cc-old',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      cancel: vi.fn(),
      send: vi.fn(() => 'queued'),
      pendingCount: 2,
      pendingMessages: ['a', 'b'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-cc' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'claude-code-sdk',
      projectDir: '/proj',
      label: 'Brain',
      description: 'desc',
      requestedModel: 'sonnet',
      effort: 'high',
      transportConfig: { supervision: { mode: 'off' } },
      ccPreset: 'preset-a',
      fresh: true,
      ccSessionId: expect.any(String),
    }));
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: '/clear', allowDuplicate: true, commandId: 'cmd-clear-cc' },
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'assistant.text', {
      text: 'Started a fresh conversation',
      streaming: false,
      memoryExcluded: true,
    }, expect.objectContaining({ source: 'daemon' }));
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-cc', status: 'accepted' });
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({ state: 'queued' }),
      expect.anything(),
    );
  });

  it('passes requestedModel when starting a copilot-sdk main session', async () => {
    handleWebCommand({
      type: 'session.start',
      project: 'transport',
      dir: '/proj',
      agentType: 'copilot-sdk',
      requestedModel: 'gpt-5.4-mini',
      thinking: 'high',
    }, serverLink as any);
    await flushAsync();

    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'copilot-sdk',
      projectDir: '/proj',
      requestedModel: 'gpt-5.4-mini',
      effort: 'high',
    }));
  });

  it('passes requestedModel when starting a cursor-headless main session', async () => {
    handleWebCommand({
      type: 'session.start',
      project: 'transport',
      dir: '/proj',
      agentType: 'cursor-headless',
      requestedModel: 'gpt-5.2',
    }, serverLink as any);
    await flushAsync();

    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'cursor-headless',
      projectDir: '/proj',
      requestedModel: 'gpt-5.2',
    }));
  });

  it('passes requestedModel when starting a kimi-sdk main session', async () => {
    handleWebCommand({
      type: 'session.start',
      project: 'transport',
      dir: '/proj',
      agentType: 'kimi-sdk',
      requestedModel: 'moonshot-v1-auto,thinking',
    }, serverLink as any);
    await flushAsync();

    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'kimi-sdk',
      projectDir: '/proj',
      fresh: true,
      requestedModel: 'moonshot-v1-auto,thinking',
    }));
  });

  it('dispatches /clear as a fresh openclaw relaunch that preserves the provider key', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'openclaw',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      providerSessionId: 'agent___main___discord___chan',
      requestedModel: 'oc-model',
      effort: 'medium',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'agent___main___discord___chan',
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['a'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-oc' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'openclaw',
      projectDir: '/proj',
      requestedModel: 'oc-model',
      effort: 'medium',
      bindExistingKey: 'agent___main___discord___chan',
      fresh: true,
    }));
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-oc', status: 'accepted' });
  });

  it('dispatches /clear as a fresh qwen relaunch without preserving the provider key', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      providerSessionId: 'qwen-route-old',
      requestedModel: 'qwen-plus',
      effort: 'low',
      ccPreset: 'preset-q',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'qwen-route-old',
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['a'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-qwen' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'qwen',
      projectDir: '/proj',
      requestedModel: 'qwen-plus',
      effort: 'low',
      ccPreset: 'preset-q',
      fresh: true,
    }));
    expect(launchTransportSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('bindExistingKey');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-qwen', status: 'accepted' });
  });

  it('dispatches /clear as a fresh codex-sdk relaunch', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'codex-sdk',
      runtimeType: 'transport',
      state: 'running',
      projectDir: '/proj',
      requestedModel: 'gpt-5.4-codex',
      effort: 'medium',
      codexSessionId: 'thread-old',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-codex-old',
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['a'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/clear', commandId: 'cmd-clear-codex' }, serverLink as any);
    await flushAsync();

    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'codex-sdk',
      projectDir: '/proj',
      requestedModel: 'gpt-5.4-codex',
      effort: 'medium',
      fresh: true,
    }));
    expect(launchTransportSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('bindExistingKey');
    expect(launchTransportSessionMock.mock.calls.at(-1)?.[0]).not.toHaveProperty('codexSessionId');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-clear-codex', status: 'accepted' });
  });

  it('dispatches direct session.cancel immediately for transport sessions without emitting /stop text', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      cancel,
      send: vi.fn(() => 'queued'),
      pendingCount: 3,
      pendingMessages: ['a', 'b', 'c'],
    });

    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL,
      sessionName: 'deck_transport_brain',
      commandId: 'cmd-stop',
    }, serverLink as any);
    await flushAsync();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-stop', status: 'accepted' });
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      {
        state: SESSION_CONTROL_TIMELINE_STATE_STOPPING,
        reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
      },
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      {
        state: 'idle',
        pendingCount: 3,
        pendingMessages: ['a', 'b', 'c'],
        pendingMessageEntries: [],
      },
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
    const stopFeedbackOrder = firstInvocationOrder((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'session.state'
      && (call[2] as Record<string, unknown>)?.state === SESSION_CONTROL_TIMELINE_STATE_STOPPING
      && (call[2] as Record<string, unknown>)?.reason === SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
    );
    const idleOrder = firstInvocationOrder((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'session.state'
      && (call[2] as Record<string, unknown>)?.state === 'idle',
    );
    expect(stopFeedbackOrder).toBeLessThan(idleOrder);
    expect(stopFeedbackOrder).toBeLessThan(cancel.mock.invocationCallOrder[0]);
    const stopUserMessages = emitMock.mock.calls.filter((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'user.message'
      && (call[2] as Record<string, unknown>)?.text === '/stop',
    );
    expect(stopUserMessages).toEqual([]);
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({ state: 'queued' }),
      expect.anything(),
    );
  });

  it('keeps legacy /stop sends as direct cancel compatibility without emitting /stop text', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      cancel,
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['a'],
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/stop', commandId: 'cmd-stop-legacy' }, serverLink as any);
    await flushAsync();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-stop-legacy',
      status: 'accepted',
    });
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      {
        state: SESSION_CONTROL_TIMELINE_STATE_STOPPING,
        reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
      },
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
    const stopUserMessages = emitMock.mock.calls.filter((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'user.message'
      && (call[2] as Record<string, unknown>)?.text === '/stop',
    );
    expect(stopUserMessages).toEqual([]);
  });

  it('acks /stop before provider cancellation settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      cancel,
      send: vi.fn(() => 'queued'),
      pendingCount: 1,
      pendingMessages: ['blocked send'],
    });

    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL,
      sessionName: 'deck_transport_brain',
      commandId: 'cmd-stop-cancel-hang',
    }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-stop-cancel-hang',
      status: 'accepted',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    const ackOrder = firstInvocationOrder((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'command.ack'
      && (call[2] as Record<string, unknown>)?.commandId === 'cmd-stop-cancel-hang',
    );
    expect(ackOrder).toBeLessThan(cancel.mock.invocationCallOrder[0]);
  });

  it('keeps direct session.cancel on the priority lane while a transport model switch holds the send lock', async () => {
    let resolveRuntimeConfig: ((value: unknown) => void) | null = null;
    getQwenRuntimeConfigMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntimeConfig = resolve;
    }));
    const setAgentId = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      qwenAvailableModels: ['qwen-plus', 'qwen-max'],
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      setAgentId,
      cancel,
      send: vi.fn(() => 'sent'),
      pendingCount: 0,
      pendingMessages: [],
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model qwen-max',
      commandId: 'cmd-stop-priority-model',
    }, serverLink as any);
    await flushAsync();

    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_CANCEL,
      sessionName: 'deck_transport_brain',
      commandId: 'cmd-stop-priority',
    }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-stop-priority',
      status: 'accepted',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(setAgentId).not.toHaveBeenCalled();

    resolveRuntimeConfig?.({ availableModels: ['qwen-plus', 'qwen-max'] });
    await flushAsync();
    await flushAsync();
  });

  it('keeps legacy /stop on the priority lane while a transport model switch holds the send lock', async () => {
    let resolveRuntimeConfig: ((value: unknown) => void) | null = null;
    getQwenRuntimeConfigMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntimeConfig = resolve;
    }));
    const setAgentId = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      qwenAvailableModels: ['qwen-plus', 'qwen-max'],
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      setAgentId,
      cancel,
      send: vi.fn(() => 'sent'),
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model qwen-max',
      commandId: 'cmd-stop-priority-model-legacy',
    }, serverLink as any);
    await flushAsync();

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/stop',
      commandId: 'cmd-stop-priority-legacy',
    }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-stop-priority-legacy',
      status: 'accepted',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(setAgentId).not.toHaveBeenCalled();

    resolveRuntimeConfig?.({ availableModels: ['qwen-plus', 'qwen-max'] });
    await flushAsync();
    await flushAsync();
  });

  it('emits a user.message immediately for dispatched transport sends', async () => {
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: vi.fn(() => 'sent'),
      pendingCount: 0,
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'sent msg', commandId: 'cmd-sent' }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: 'sent msg', allowDuplicate: true, commandId: 'cmd-sent', clientMessageId: 'cmd-sent' },
      expect.objectContaining({ eventId: 'transport-user:cmd-sent' }),
    );
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({ state: 'queued' }),
      expect.anything(),
    );
  });

  it('emits ordinary send ack synchronously before the first async delivery boundary', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'ack at daemon receipt, then deliver later',
      commandId: 'cmd-receipt-first',
    }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-receipt-first',
      status: 'accepted',
    });
    expect(transportSend).not.toHaveBeenCalled();

    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('ack at daemon receipt, then deliver later', 'cmd-receipt-first');
    const ackOrder = firstInvocationOrder((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'command.ack'
      && (call[2] as Record<string, unknown>)?.commandId === 'cmd-receipt-first',
    );
    expect(ackOrder).toBeLessThan(transportSend.mock.invocationCallOrder[0]);
  });

  it('strips trusted leading @pref lines from user text but sends rendered preference context without waiting for persistence', async () => {
    enablePreferenceFeature();
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '@pref: Use pnpm\n\nPlease run tests',
      commandId: 'cmd-pref-trusted',
      origin: 'user_keyboard',
      userId: 'user-1',
    }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-pref-trusted',
      status: 'accepted',
    });
    expect(transportSend).not.toHaveBeenCalled();
    expect(writeContextObservationMock).not.toHaveBeenCalled();

    await flushAsync();
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith(
      'Please run tests',
      'cmd-pref-trusted',
      undefined,
      expect.stringContaining('Use pnpm'),
    );
    expect(transportSend.mock.calls[0]?.[3]).toContain(PREFERENCE_CONTEXT_START);
    expect(transportSend.mock.calls[0]?.[3]).not.toContain('@pref:');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: 'Please run tests', allowDuplicate: true, commandId: 'cmd-pref-trusted', clientMessageId: 'cmd-pref-trusted' },
      expect.objectContaining({ eventId: 'transport-user:cmd-pref-trusted' }),
    );
    expect(ensureContextNamespaceMock).toHaveBeenCalledWith({
      scope: PREFERENCE_INGEST_SCOPE,
      userId: 'user-1',
      name: 'preferences',
    });
    expect(writeContextObservationMock).toHaveBeenCalledWith(expect.objectContaining({
      namespaceId: 'pref-namespace',
      scope: PREFERENCE_INGEST_SCOPE,
      class: PREFERENCE_INGEST_OBSERVATION_CLASS,
      origin: PREFERENCE_INGEST_ORIGIN,
      content: expect.objectContaining({ text: 'Use pnpm' }),
      sourceEventIds: ['cmd-pref-trusted'],
      state: PREFERENCE_INGEST_OBSERVATION_STATE,
    }));
    const ackOrder = firstInvocationOrder((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'command.ack'
      && (call[2] as Record<string, unknown>)?.commandId === 'cmd-pref-trusted',
    );
    expect(ackOrder).toBeLessThan(transportSend.mock.invocationCallOrder[0]);
    expect(ackOrder).toBeLessThan(listContextObservationsMock.mock.invocationCallOrder[0]);
    expect(ackOrder).toBeLessThan(writeContextObservationMock.mock.invocationCallOrder[0]);
  });

  it('renders persisted preferences into future provider sends while leaving timeline text unchanged', async () => {
    enablePreferenceFeature();
    listContextObservationsMock.mockReturnValueOnce([
      {
        id: 'pref-observation',
        namespaceId: 'pref-namespace',
        scope: PREFERENCE_INGEST_SCOPE,
        class: PREFERENCE_INGEST_OBSERVATION_CLASS,
        origin: PREFERENCE_INGEST_ORIGIN,
        fingerprint: 'pref-fingerprint',
        content: {
          text: 'Use pnpm',
          idempotencyKey: `${PREFERENCE_IDEMPOTENCY_PREFIX}\u0000user-1\u0000${PREFERENCE_INGEST_SCOPE}:user-1\u0000old-message\u0000pref-fingerprint`,
        },
        textHash: 'hash',
        sourceEventIds: ['old-message'],
        state: PREFERENCE_INGEST_OBSERVATION_STATE,
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'Please run tests',
      commandId: 'cmd-pref-future',
      origin: 'user_keyboard',
      userId: 'user-1',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith(
      'Please run tests',
      'cmd-pref-future',
      undefined,
      expect.stringContaining('Use pnpm'),
    );
    expect(writeContextObservationMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: 'Please run tests', allowDuplicate: true, commandId: 'cmd-pref-future', clientMessageId: 'cmd-pref-future' },
      expect.objectContaining({ eventId: 'transport-user:cmd-pref-future' }),
    );
  });

  it('fails closed for missing or untrusted @pref origins without stripping provider text', async () => {
    enablePreferenceFeature();
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '@pref: Do not trust missing origin\nRun it',
      commandId: 'cmd-pref-missing-origin',
    }, serverLink as any);
    await flushAsync();

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '@pref: Agent-authored syntax\nRun it',
      commandId: 'cmd-pref-agent-origin',
      origin: 'agent_output',
      userId: 'user-1',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('@pref: Do not trust missing origin\nRun it', 'cmd-pref-missing-origin');
    expect(transportSend).toHaveBeenCalledWith('@pref: Agent-authored syntax\nRun it', 'cmd-pref-agent-origin');
    expect(ensureContextNamespaceMock).not.toHaveBeenCalled();
    expect(writeContextObservationMock).not.toHaveBeenCalled();
  });

  it('passes trusted @pref text through unchanged when preferences are disabled', async () => {
    vi.stubEnv(PREFERENCE_FEATURE_ENV_KEY, '0');
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '@pref: Use tabs\nKeep coding',
      commandId: 'cmd-pref-disabled',
      origin: 'user_keyboard',
      userId: 'user-1',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('@pref: Use tabs\nKeep coding', 'cmd-pref-disabled');
    expect(ensureContextNamespaceMock).not.toHaveBeenCalled();
    expect(writeContextObservationMock).not.toHaveBeenCalled();
  });

  it('acks ordinary transport sends before waiting on a prior control command lock', async () => {
    let resolveRuntimeConfig: ((value: unknown) => void) | null = null;
    getQwenRuntimeConfigMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntimeConfig = resolve;
    }));
    const transportSend = vi.fn(() => 'sent');
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      qwenAvailableModels: ['qwen-plus', 'qwen-max'],
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      setAgentId,
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model qwen-max',
      commandId: 'cmd-model-hold',
    }, serverLink as any);
    await flushAsync();

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'normal while model switch is probing',
      commandId: 'cmd-normal-during-lock',
    }, serverLink as any);
    await flushAsync();
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-normal-during-lock',
      status: 'accepted',
    });
    expect(transportSend).not.toHaveBeenCalledWith('normal while model switch is probing', 'cmd-normal-during-lock');

    resolveRuntimeConfig?.({
      availableModels: ['qwen-plus', 'qwen-max'],
    });
    await flushAsync();
    await flushAsync();
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('qwen-max');
    expect(transportSend).toHaveBeenCalledWith('normal while model switch is probing', 'cmd-normal-during-lock');
  });

  it('acks ordinary transport sends before provider send-start settles', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS', '30');
    const providerSend = vi.fn(() => new Promise(() => {}));
    const runtime = new TransportSessionRuntime(makeRuntimeProvider(providerSend), 'deck_transport_brain');
    await runtime.initialize({
      sessionKey: 'deck_transport_brain',
      contextNamespace: { scope: 'personal', projectId: 'transport' },
      contextLocalProcessedFreshness: 'fresh',
    });
    getTransportRuntimeMock.mockReturnValue(runtime);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'ordinary provider send-start should not hold ack',
      commandId: 'cmd-provider-start-hang',
    }, serverLink as any);
    await flushAsync();
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-provider-start-hang',
      status: 'accepted',
    });
    expect(providerSend).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'ordinary provider send-start should not hold ack',
    }));
    const ackOrder = firstInvocationOrder((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'command.ack'
      && (call[2] as Record<string, unknown>)?.commandId === 'cmd-provider-start-hang',
    );
    expect(ackOrder).toBeLessThan(providerSend.mock.invocationCallOrder[0]);
  });

  it('acks before bootstrap/recall finish and still sends the SDK turn without recall after failures', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '30');
    searchLocalMemorySemanticMock.mockRejectedValueOnce(new Error('recall failed'));
    const providerSend = vi.fn().mockResolvedValue(undefined);
    const runtime = new TransportSessionRuntime(makeRuntimeProvider(providerSend), 'deck_transport_brain');
    await runtime.initialize({
      sessionKey: 'deck_transport_brain',
      contextNamespace: { scope: 'personal', projectId: 'transport' },
      contextLocalProcessedFreshness: 'fresh',
    });
    runtime.setContextBootstrapResolver(() => new Promise(() => {}));
    getTransportRuntimeMock.mockReturnValue(runtime);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'ordinary recall failure should still reach sdk',
      commandId: 'cmd-bootstrap-recall-fail',
    }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-bootstrap-recall-fail',
      status: 'accepted',
    });
    expect(providerSend).not.toHaveBeenCalled();

    await sleep(80);
    await flushAsync();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalled();
    expect(providerSend).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'ordinary recall failure should still reach sdk',
      assembledMessage: 'ordinary recall failure should still reach sdk',
    }));
    expect(providerSend.mock.calls[0][1]).not.toHaveProperty('memoryRecall');
    const ackOrder = firstInvocationOrder((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'command.ack'
      && (call[2] as Record<string, unknown>)?.commandId === 'cmd-bootstrap-recall-fail',
    );
    expect(ackOrder).toBeLessThan(providerSend.mock.invocationCallOrder[0]);
  });

  it('acks ordinary transport sends while a timeline history worker request is still active', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    let resolveHistory!: (value: {
      events: unknown[];
      eventsRead: number;
      payloadBytes: number;
      droppedEvents: number;
      truncatedEvents: number;
      readMs: number;
      sanitizeMs: number;
    }) => void;
    historyWorkerDispatchMock.mockReturnValue(new Promise((resolve) => {
      resolveHistory = resolve;
    }));
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'hist-worker-still-running',
      limit: 50,
    }, serverLink as any);
    await flushAsync();

    expect(historyWorkerDispatchMock).toHaveBeenCalled();
    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'do not wait for timeline hydration',
      commandId: 'cmd-while-history-worker-active',
    }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-while-history-worker-active',
      status: 'accepted',
    });
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-while-history-worker-active',
      status: 'accepted',
      session: 'deck_transport_brain',
    });
    expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId: 'hist-worker-still-running',
    }));

    await flushAsync();
    expect(transportSend).toHaveBeenCalledWith('do not wait for timeline hydration', 'cmd-while-history-worker-active');

    const ackSendOrder = serverLink.send.mock.invocationCallOrder.find((_, index) => {
      const msg = serverLink.send.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
      return msg?.type === 'command.ack' && msg.commandId === 'cmd-while-history-worker-active';
    }) ?? Number.POSITIVE_INFINITY;

    resolveHistory({
      events: [],
      eventsRead: 0,
      payloadBytes: 2,
      droppedEvents: 0,
      truncatedEvents: 0,
      readMs: 250,
      sanitizeMs: 0,
    });
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId: 'hist-worker-still-running',
      status: TIMELINE_RESPONSE_STATUS.OK,
      source: TIMELINE_RESPONSE_SOURCES.WORKER_SQLITE,
    }));
    const historySendOrder = serverLink.send.mock.invocationCallOrder.find((_, index) => {
      const msg = serverLink.send.mock.calls[index]?.[0] as Record<string, unknown> | undefined;
      return msg?.type === TIMELINE_MESSAGES.HISTORY && msg.requestId === 'hist-worker-still-running';
    }) ?? Number.POSITIVE_INFINITY;
    expect(ackSendOrder).toBeLessThan(historySendOrder);
  });

  it('coalesces equivalent in-flight timeline history requests while preserving request ids', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    let resolveHistory!: (value: {
      events: unknown[];
      eventsRead: number;
      payloadBytes: number;
      droppedEvents: number;
      truncatedEvents: number;
      readMs: number;
      sanitizeMs: number;
    }) => void;
    historyWorkerDispatchMock.mockReturnValue(new Promise((resolve) => {
      resolveHistory = resolve;
    }));

    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'hist-coalesce-1',
      limit: 50,
    }, serverLink as any);
    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'hist-coalesce-2',
      limit: 50,
    }, serverLink as any);
    await flushAsync();

    expect(historyWorkerDispatchMock).toHaveBeenCalledTimes(1);
    resolveHistory({
      events: [],
      eventsRead: 0,
      payloadBytes: 2,
      droppedEvents: 0,
      truncatedEvents: 0,
      readMs: 50,
      sanitizeMs: 0,
    });
    await flushAsync();
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId: 'hist-coalesce-1',
      status: TIMELINE_RESPONSE_STATUS.OK,
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.HISTORY,
      requestId: 'hist-coalesce-2',
      status: TIMELINE_RESPONSE_STATUS.OK,
    }));
  });

  it('shapes multi-MB timeline.replay payloads under the default envelope budget without legacy gap truncation', async () => {
    vi.mocked(timelineEmitter.replay).mockReturnValueOnce({
      truncated: false,
      source: TIMELINE_RESPONSE_SOURCES.RING_BUFFER,
      events: Array.from({ length: 80 }, (_, index) => timelineEvent({
        eventId: `replay-tool-${index}`,
        ts: index,
        seq: index,
        payload: {
          tool: 'shell',
          output: `${index}: ${'x'.repeat(128 * 1024)}`,
          detail: { raw: { stdout: 'x'.repeat(1024 * 1024) } },
        },
      })),
    });

    handleWebCommand({
      type: TIMELINE_MESSAGES.REPLAY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'replay-big',
      afterSeq: 0,
      epoch: 0,
    }, serverLink as any);
    await flushAsync();

    const response = serverLink.send.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((msg) => msg.requestId === 'replay-big');
    expect(response).toMatchObject({
      type: TIMELINE_MESSAGES.REPLAY,
      status: TIMELINE_RESPONSE_STATUS.PARTIAL,
      source: TIMELINE_RESPONSE_SOURCES.RING_BUFFER,
      truncated: false,
      payloadTruncated: true,
    });
    expect(response?.payloadBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE);
    expect(Buffer.byteLength(JSON.stringify(response?.events), 'utf8')).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE);
  });

  it('shapes epoch-mismatch replay from the SQLite projection under the default envelope budget', async () => {
    // Epoch-reset replay now reads the SQLite projection (sole chat-history
    // source) instead of falling back to a synchronous JSONL tail scan.
    vi.mocked(timelineStore.readPreferred).mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => timelineEvent({
      eventId: `sqlite-tail-${index}`,
      ts: index,
      seq: index,
      payload: { output: 'j'.repeat(96 * 1024), detail: { output: 'j'.repeat(96 * 1024) } },
    })) as never);

    handleWebCommand({
      type: TIMELINE_MESSAGES.REPLAY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'replay-epoch-reset',
      afterSeq: 10,
      epoch: -1,
    }, serverLink as any);
    await flushAsync();

    const response = serverLink.send.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((msg) => msg.requestId === 'replay-epoch-reset');
    expect(response).toMatchObject({
      type: TIMELINE_MESSAGES.REPLAY,
      status: TIMELINE_RESPONSE_STATUS.PARTIAL,
      source: TIMELINE_RESPONSE_SOURCES.MAIN_SQLITE,
      cursorReset: true,
      payloadTruncated: true,
    });
    expect(response?.payloadBytes).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE);
    expect(Buffer.byteLength(JSON.stringify(response?.events), 'utf8')).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.DEFAULT_ENVELOPE);
  });

  it('coalesces equivalent in-flight timeline.replay requests while preserving request ids', async () => {
    vi.mocked(timelineEmitter.replay).mockReturnValueOnce({
      truncated: false,
      source: TIMELINE_RESPONSE_SOURCES.RING_BUFFER,
      events: [timelineEvent({
        eventId: 'replay-coalesced-event',
        payload: { text: 'shared replay' },
      })],
    });

    handleWebCommand({
      type: TIMELINE_MESSAGES.REPLAY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'replay-coalesce-1',
      afterSeq: 41,
      epoch: 0,
    }, serverLink as any);
    handleWebCommand({
      type: TIMELINE_MESSAGES.REPLAY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'replay-coalesce-2',
      afterSeq: 41,
      epoch: 0,
    }, serverLink as any);
    await flushAsync();

    expect(timelineEmitter.replay).toHaveBeenCalledTimes(1);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.REPLAY,
      requestId: 'replay-coalesce-1',
      events: [expect.objectContaining({ eventId: 'replay-coalesced-event' })],
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.REPLAY,
      requestId: 'replay-coalesce-2',
      events: [expect.objectContaining({ eventId: 'replay-coalesced-event' })],
    }));
  });

  it('returns a terminal malformed error for invalid timeline.replay requests', async () => {
    handleWebCommand({
      type: TIMELINE_MESSAGES.REPLAY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'replay-malformed',
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.REPLAY,
      sessionName: 'deck_transport_brain',
      requestId: 'replay-malformed',
      status: TIMELINE_RESPONSE_STATUS.ERROR,
      source: TIMELINE_RESPONSE_SOURCES.ERROR,
      errorReason: TIMELINE_REQUEST_ERROR_REASONS.MALFORMED_REQUEST,
      events: [],
      payloadBytes: 2,
      payloadTruncated: false,
    }));
    expect(timelineEmitter.replay).not.toHaveBeenCalled();
  });

  it('acks ordinary transport sends while a data-plane serverLink.send promise is unsettled', async () => {
    let resolveDataPlane!: () => void;
    serverLink.send.mockImplementation((msg: { type?: string }) => {
      if (msg.type === TIMELINE_MESSAGES.DETAIL) {
        return new Promise<void>((resolve) => {
          resolveDataPlane = resolve;
        });
      }
      return undefined;
    });
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'detail-data-plane-pending',
      detailId: 'detail-1',
    }, serverLink as any);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.DETAIL,
      requestId: 'detail-data-plane-pending',
    }));

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'do not wait for data-plane send settlement',
      commandId: 'cmd-while-detail-send-pending',
    }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-while-detail-send-pending',
      status: 'accepted',
    });
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-while-detail-send-pending',
      status: 'accepted',
      session: 'deck_transport_brain',
    });

    await flushAsync();
    expect(transportSend).toHaveBeenCalledWith('do not wait for data-plane send settlement', 'cmd-while-detail-send-pending');
    resolveDataPlane();
  });

  it('acks ordinary transport sends within the hot path while synthetic data-plane jobs are active', async () => {
    shouldUseHistoryWorkerMock.mockReturnValue(true);
    historyWorkerDispatchMock.mockReturnValue(new Promise(() => {}));
    vi.mocked(timelineEmitter.replay).mockReturnValueOnce({
      truncated: false,
      source: TIMELINE_RESPONSE_SOURCES.RING_BUFFER,
      events: Array.from({ length: 60 }, (_, index) => timelineEvent({
        eventId: `synthetic-replay-${index}`,
        ts: index,
        seq: index,
        payload: { output: 'x'.repeat(64 * 1024) },
      })),
    });
    getProviderMock.mockReturnValue({
      listModels: vi.fn(() => new Promise(() => {})),
    });
    const ref = getDefaultTimelineDetailStore().put({
      sessionName: 'deck_transport_brain',
      epoch: 0,
      eventId: 'evt-load',
      fieldPath: 'payload.output',
      value: 'load detail',
    });
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: TIMELINE_MESSAGES.HISTORY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'load-history',
      limit: 50,
    }, serverLink as any);
    handleWebCommand({
      type: TIMELINE_MESSAGES.PAGE_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'load-page',
      limit: 50,
      cursor: { epoch: 0, beforeTs: 10, direction: TIMELINE_CURSOR_DIRECTIONS.OLDER },
    }, serverLink as any);
    handleWebCommand({
      type: TIMELINE_MESSAGES.REPLAY_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'load-replay',
      afterSeq: 1,
      epoch: 0,
    }, serverLink as any);
    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'load-detail',
      detailId: ref!.detailId,
      eventId: 'evt-load',
      fieldPath: 'payload.output',
    }, serverLink as any);
    handleWebCommand({
      type: 'transport.list_models',
      agentType: 'codex-sdk',
      providerId: 'local',
      requestId: 'load-models',
    }, serverLink as any);

    const startedAt = performance.now();
    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'ack under synthetic load',
      commandId: 'cmd-synthetic-load',
    }, serverLink as any);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-synthetic-load',
      status: 'accepted',
      session: 'deck_transport_brain',
    });
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-synthetic-load',
      status: 'accepted',
    });
    expect(transportSend).not.toHaveBeenCalled();

    await flushAsync();
    expect(transportSend).toHaveBeenCalledWith('ack under synthetic load', 'cmd-synthetic-load');
  });

  it('serves timeline.detail from the scoped detail store and rejects mismatched bindings', async () => {
    const ref = getDefaultTimelineDetailStore().put({
      sessionName: 'deck_transport_brain',
      epoch: 0,
      eventId: 'evt-detail',
      fieldPath: 'payload.output',
      value: 'full detail output',
      previewBytes: 1024,
    });

    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'detail-ok',
      detailId: ref!.detailId,
      epoch: 0,
      eventId: 'evt-detail',
      fieldPath: 'payload.output',
    }, serverLink as any);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.DETAIL,
      requestId: 'detail-ok',
      detailId: ref!.detailId,
      status: TIMELINE_RESPONSE_STATUS.OK,
      source: TIMELINE_RESPONSE_SOURCES.CACHE,
      payloadBytes: expect.any(Number),
      payloadTruncated: false,
      value: 'full detail output',
    }));
    const detailOk = serverLink.send.mock.calls.find((call) => (call[0] as Record<string, unknown>).requestId === 'detail-ok')?.[0];
    expect(Buffer.byteLength(JSON.stringify(detailOk), 'utf8')).toBeLessThanOrEqual(TIMELINE_PAYLOAD_BUDGET_BYTES.EXPLICIT_PAGE_OR_DETAIL);

    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'detail-bad-field',
      detailId: ref!.detailId,
      epoch: 0,
      eventId: 'evt-detail',
      fieldPath: 'payload.error',
    }, serverLink as any);

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TIMELINE_MESSAGES.DETAIL,
      requestId: 'detail-bad-field',
      status: TIMELINE_RESPONSE_STATUS.ERROR,
      // eventId/fieldPath mismatch returns MISSING rather than UNAUTHORIZED
      // to avoid leaking detailId existence (CC1 #11 / tasks.md 2.5 / spec D6)
      errorReason: TIMELINE_DETAIL_ERROR_REASONS.MISSING,
    }));
  });

  it('returns stable terminal errors for malformed, missing, oversized, cross-session, and internal timeline.detail requests', async () => {
    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'detail-malformed',
    }, serverLink as any);

    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'detail-missing',
      detailId: 'td_missing',
      epoch: 0,
    }, serverLink as any);

    const oversized = getDefaultTimelineDetailStore().put({
      sessionName: 'deck_transport_brain',
      epoch: 0,
      eventId: 'evt-big',
      fieldPath: 'payload.output',
      value: 'x'.repeat(2 * 1024 * 1024),
    });
    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'detail-oversized',
      detailId: oversized!.detailId,
      epoch: 0,
    }, serverLink as any);

    const scoped = getDefaultTimelineDetailStore().put({
      sessionName: 'deck_transport_brain',
      epoch: 0,
      eventId: 'evt-scoped',
      fieldPath: 'payload.output',
      value: 'private detail',
    });
    getSessionMock.mockImplementation((name: string) => ({
      name,
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
    }));
    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_other_brain',
      requestId: 'detail-cross-session',
      detailId: scoped!.detailId,
      epoch: 0,
    }, serverLink as any);

    const store = getDefaultTimelineDetailStore();
    vi.spyOn(store, 'get').mockImplementationOnce(() => {
      throw new Error('detail store failed');
    });
    handleWebCommand({
      type: TIMELINE_MESSAGES.DETAIL_REQUEST,
      sessionName: 'deck_transport_brain',
      requestId: 'detail-internal',
      detailId: scoped!.detailId,
      epoch: 0,
    }, serverLink as any);

    const reasonByRequestId = new Map(
      serverLink.send.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((msg) => msg.type === TIMELINE_MESSAGES.DETAIL)
        .map((msg) => [msg.requestId, msg.errorReason]),
    );
    expect(reasonByRequestId.get('detail-malformed')).toBe(TIMELINE_DETAIL_ERROR_REASONS.MALFORMED);
    expect(reasonByRequestId.get('detail-missing')).toBe(TIMELINE_DETAIL_ERROR_REASONS.MISSING);
    expect(reasonByRequestId.get('detail-oversized')).toBe(TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED);
    expect(reasonByRequestId.get('detail-cross-session')).toBe(TIMELINE_DETAIL_ERROR_REASONS.MISSING);
    expect(reasonByRequestId.get('detail-internal')).toBe(TIMELINE_DETAIL_ERROR_REASONS.INTERNAL_ERROR);
  });

  it('coalesces concurrent transport.list_models requests for the same agent/provider and preserves request ids', async () => {
    let resolveModels!: (value: { models: Array<{ id: string }> }) => void;
    const listModels = vi.fn(() => new Promise((resolve) => {
      resolveModels = resolve;
    }));
    getProviderMock.mockReturnValue({ listModels });

    handleWebCommand({ type: 'transport.list_models', agentType: 'codex-sdk', providerId: 'local', requestId: 'models-1' }, serverLink as any);
    handleWebCommand({ type: 'transport.list_models', agentType: 'codex-sdk', providerId: 'local', requestId: 'models-2' }, serverLink as any);
    await flushAsync();

    expect(listModels).toHaveBeenCalledTimes(1);
    resolveModels({ models: [{ id: 'gpt-5-codex' }] });
    await flushAsync();
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: 'models-1',
      models: [{ id: 'gpt-5-codex' }],
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: 'models-2',
      models: [{ id: 'gpt-5-codex' }],
    }));
  });

  it('serves transport.list_models from TTL cache without probing the provider again', async () => {
    const listModels = vi.fn().mockResolvedValue({ models: [{ id: 'cached-model' }], defaultModel: 'cached-model' });
    getProviderMock.mockReturnValue({ listModels });

    handleWebCommand({ type: 'transport.list_models', agentType: 'gemini-sdk', requestId: 'ttl-1' }, serverLink as any);
    await flushAsync();
    await flushAsync();

    handleWebCommand({ type: 'transport.list_models', agentType: 'gemini-sdk', requestId: 'ttl-2' }, serverLink as any);
    await flushAsync();

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      requestId: 'ttl-2',
      models: [{ id: 'cached-model' }],
      defaultModel: 'cached-model',
    }));
    expect(__resolveTransportListModelsCacheTtlMsForTests()).toBe(5_000);
    vi.stubEnv('IMCODES_TRANSPORT_LIST_MODELS_CACHE_TTL_MS', '120000');
    expect(__resolveTransportListModelsCacheTtlMsForTests()).toBe(60_000);
  });

  it('invalidates transport.list_models TTL cache when session transport config changes', async () => {
    const listModels = vi.fn()
      .mockResolvedValueOnce({ models: [{ id: 'old-config-model' }] })
      .mockResolvedValueOnce({ models: [{ id: 'new-config-model' }] });
    getProviderMock.mockReturnValue({ listModels });

    handleWebCommand({ type: 'transport.list_models', agentType: 'codex-sdk', providerId: 'local', requestId: 'config-cache-1' }, serverLink as any);
    await flushAsync();
    await flushAsync();

    handleWebCommand({
      type: 'session.update_transport_config',
      sessionName: 'deck_transport_brain',
      transportConfig: { providerId: 'local', apiKeyRef: 'synthetic-next' },
    }, serverLink as any);
    await flushAsync();

    handleWebCommand({ type: 'transport.list_models', agentType: 'codex-sdk', providerId: 'local', requestId: 'config-cache-2' }, serverLink as any);
    await flushAsync();
    await flushAsync();

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      requestId: 'config-cache-2',
      models: [{ id: 'new-config-model' }],
    }));
  });

  it('does not let stale transport.list_models inflight results repopulate cache after invalidation', async () => {
    let resolveOld!: (value: { models: Array<{ id: string }> }) => void;
    let resolveNew!: (value: { models: Array<{ id: string }> }) => void;
    const listModels = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNew = resolve; }));
    getProviderMock.mockReturnValue({ listModels });

    handleWebCommand({ type: 'transport.list_models', agentType: 'gemini-sdk', providerId: 'local', requestId: 'stale-inflight-1' }, serverLink as any);
    await flushAsync();
    expect(listModels).toHaveBeenCalledTimes(1);

    __invalidateTransportListModelsCacheForTests('synthetic_config_change');
    resolveOld({ models: [{ id: 'stale-model' }] });
    await flushAsync();
    await flushAsync();

    handleWebCommand({ type: 'transport.list_models', agentType: 'gemini-sdk', providerId: 'local', requestId: 'stale-inflight-2' }, serverLink as any);
    await flushAsync();
    expect(listModels).toHaveBeenCalledTimes(2);
    resolveNew({ models: [{ id: 'fresh-model' }] });
    await flushAsync();
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      requestId: 'stale-inflight-2',
      models: [{ id: 'fresh-model' }],
    }));
    expect(serverLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stale-inflight-2',
      models: [{ id: 'stale-model' }],
    }));
  });

  it('refreshes transport.list_models after TTL expiry', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_LIST_MODELS_CACHE_TTL_MS', '5');
    const listModels = vi.fn()
      .mockResolvedValueOnce({ models: [{ id: 'old-model' }] })
      .mockResolvedValueOnce({ models: [{ id: 'new-model' }] });
    getProviderMock.mockReturnValue({ listModels });

    handleWebCommand({ type: 'transport.list_models', agentType: 'cursor-headless', requestId: 'expire-1' }, serverLink as any);
    await flushAsync();
    await flushAsync();
    await sleep(10);
    handleWebCommand({ type: 'transport.list_models', agentType: 'cursor-headless', requestId: 'expire-2' }, serverLink as any);
    await flushAsync();
    await flushAsync();

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      requestId: 'expire-2',
      models: [{ id: 'new-model' }],
    }));
  });

  it('does not cache failed transport.list_models work and allows retry', async () => {
    const listModels = vi.fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({ models: [{ id: 'retry-model' }] });
    getProviderMock.mockReturnValue({ listModels });

    handleWebCommand({ type: 'transport.list_models', agentType: 'copilot-sdk', requestId: 'fail-1' }, serverLink as any);
    await flushAsync();
    await flushAsync();
    handleWebCommand({ type: 'transport.list_models', agentType: 'copilot-sdk', requestId: 'retry-1' }, serverLink as any);
    await flushAsync();
    await flushAsync();

    expect(listModels).toHaveBeenCalledTimes(2);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      requestId: 'fail-1',
      models: [],
      error: 'probe failed',
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'transport.models_response',
      requestId: 'retry-1',
      models: [{ id: 'retry-model' }],
    }));
  });

  it.each([...TRANSPORT_SESSION_AGENT_TYPES])('forwards /compact unchanged for %s without rendering it as a user message', async (agentType) => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType,
      runtimeType: 'transport',
      state: 'running',
    });
    const commandId = `cmd-compact-${agentType}`;
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: '/compact', commandId }, serverLink as any);

    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId,
      status: 'accepted',
    });
    expect(transportSend).not.toHaveBeenCalled();

    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('/compact', commandId);
    const compactUserMessages = emitMock.mock.calls.filter((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'user.message'
      && (call[2] as { text?: string } | undefined)?.text === '/compact',
    );
    expect(compactUserMessages).toEqual([]);
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'compaction.result',
      expect.anything(),
      expect.anything(),
    );
  });

  it('shows a compact-specific visible error when transport runtime rejects /compact synchronously', async () => {
    const transportSend = vi.fn(() => {
      throw new Error('provider does not support compact');
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/compact',
      commandId: 'cmd-compact-fail',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('/compact', 'cmd-compact-fail');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      { text: '⚠️ Compact failed: provider does not support compact', streaming: false, memoryExcluded: true },
      { source: 'daemon', confidence: 'high' },
    );
    const compactUserMessages = emitMock.mock.calls.filter((call) =>
      call[0] === 'deck_transport_brain'
      && call[1] === 'user.message'
      && (call[2] as { text?: string } | undefined)?.text === '/compact',
    );
    expect(compactUserMessages).toEqual([]);
  });

  it('rejects a duplicate commandId without dispatching it to the transport runtime again', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'sent once', commandId: 'cmd-dup-transport' }, serverLink as any);
    await flushAsync();
    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'sent twice', commandId: 'cmd-dup-transport' }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledTimes(1);
    expect(transportSend).toHaveBeenCalledWith('sent once', 'cmd-dup-transport');
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', {
      commandId: 'cmd-dup-transport',
      status: 'error',
      error: COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    });
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-dup-transport',
      status: 'error',
      session: 'deck_transport_brain',
      error: COMMAND_ACK_ERROR_DUPLICATE_COMMAND_ID,
    });
    const userMessages = emitMock.mock.calls.filter((call) =>
      call[0] === 'deck_transport_brain' && call[1] === 'user.message'
      && (call[2] as Record<string, unknown>)?.commandId === 'cmd-dup-transport',
    );
    expect(userMessages).toHaveLength(1);
  });

  it('passes the raw user message to transport runtime assembly without client-side context shaping', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'review the latest patch',
      commandId: 'cmd-parity',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledTimes(1);
    expect(transportSend).toHaveBeenCalledWith('review the latest patch', 'cmd-parity');
    expect(typeof transportSend.mock.calls[0][0]).toBe('string');
  });

  it('does not short-circuit transport identity questions in the daemon', async () => {
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '你在用什么模型',
      commandId: 'cmd-identity',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('你在用什么模型', 'cmd-identity');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: '你在用什么模型', allowDuplicate: true, commandId: 'cmd-identity', clientMessageId: 'cmd-identity' },
      expect.objectContaining({ eventId: 'transport-user:cmd-identity' }),
    );
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({ text: expect.any(String), streaming: false }),
      expect.anything(),
    );
  });

  it('queues sends for resend when the transport runtime has not connected yet', async () => {
    // Reset module state between tests — the queue lives in module scope.
    const { clearAllResend, getResendEntries } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      state: 'idle',
    });
    // No runtime yet — provider is still reconnecting.
    getTransportRuntimeMock.mockReturnValue(undefined);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'first msg while offline',
      commandId: 'cmd-offline-1',
    }, serverLink as any);
    await flushAsync();

    // 1. Command is accepted, NOT errored — we queued it, we didn't drop it.
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'command.ack',
      { commandId: 'cmd-offline-1', status: 'accepted' },
    );
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-offline-1',
      status: 'accepted',
      session: 'deck_transport_brain',
    });
    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    expect(launchTransportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      agentType: 'claude-code-sdk',
      projectName: 'transport',
    }));

    // 2. NO user.message timeline event — the agent hasn't seen this message
    //    yet, it's sitting in the daemon's resend queue. Emitting a
    //    user.message here would lie to the timeline: committed rows mean
    //    "the agent saw this". The optimistic pending bubble on the web
    //    client stays in its "sending" state, and the real user.message
    //    event fires on drain when runtime.send() actually dispatches.
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.anything(),
      expect.anything(),
    );

    // 3. A memory-excluded info message explains the queued state.
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({
        text: expect.stringContaining('will resend 1 queued message'),
        streaming: false,
        memoryExcluded: true,
      }),
      expect.objectContaining({ source: 'daemon' }),
    );

    // 4. session.state reports the queued entry so the UI can surface pending count.
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({
        state: 'queued',
        pendingCount: 1,
        pendingMessageEntries: [
          { clientMessageId: 'cmd-offline-1', text: 'first msg while offline' },
        ],
      }),
      expect.objectContaining({ source: 'daemon' }),
    );

    // 5. The entry is actually sitting in the resend queue for later drain.
    expect(getResendEntries('deck_transport_brain')).toEqual([
      expect.objectContaining({ text: 'first msg while offline', commandId: 'cmd-offline-1' }),
    ]);

    // A second offline send accumulates.
    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'second msg while offline',
      commandId: 'cmd-offline-2',
    }, serverLink as any);
    await flushAsync();

    expect(getResendEntries('deck_transport_brain').map((e) => e.commandId)).toEqual([
      'cmd-offline-1',
      'cmd-offline-2',
    ]);

    // Cleanup so later tests start from empty state.
    clearAllResend();
  });

  it('queues SDK sends by agentType when runtimeType has not propagated yet', async () => {
    const { clearAllResend, getResendEntries } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'gemini-sdk',
      providerId: 'gemini-sdk',
      state: 'idle',
    });
    getTransportRuntimeMock.mockReturnValue(undefined);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model gemini-2.5-pro',
      commandId: 'cmd-missing-runtime-type-model',
    }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'command.ack',
      { commandId: 'cmd-missing-runtime-type-model', status: 'accepted' },
    );
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.anything(),
      expect.anything(),
    );
    expect(getResendEntries('deck_transport_brain')).toEqual([
      expect.objectContaining({ text: '/model gemini-2.5-pro', commandId: 'cmd-missing-runtime-type-model' }),
    ]);

    clearAllResend();
  });

  it('persists a transport error record when subsession.start fails before runtime creation', async () => {
    launchTransportSessionMock.mockRejectedValueOnce(new Error('provider bootstrap failed'));

    handleWebCommand({
      type: 'subsession.start',
      id: 'cursor_fail',
      sessionType: 'cursor-headless',
      cwd: '/tmp/project',
      parentSession: 'deck_proj_brain',
      requestedModel: 'gpt-5.4',
    }, serverLink as any);
    await flushAsync();

    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_sub_cursor_fail',
      agentType: 'cursor-headless',
      projectDir: '/tmp/project',
      runtimeType: 'transport',
      providerId: 'cursor-headless',
      state: 'error',
      parentSession: 'deck_proj_brain',
      requestedModel: 'gpt-5.4',
      userCreated: true,
    }));
    expect(emitMock).toHaveBeenCalledWith(
      'deck_sub_cursor_fail',
      'session.state',
      expect.objectContaining({ state: 'error', error: 'provider bootstrap failed' }),
      expect.objectContaining({ source: 'daemon' }),
    );
  });

  it('tracks supervision task intents while offline so Auto still follows the resent turn', async () => {
    const { clearAllResend } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      state: 'idle',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue(undefined);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'offline supervised task',
      commandId: 'cmd-offline-supervised',
    }, serverLink as any);
    await flushAsync();

    expect(queueTaskIntentMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'cmd-offline-supervised',
      'offline supervised task',
      expect.objectContaining({
        mode: 'supervised',
        backend: 'codex-sdk',
        model: 'gpt-5.4',
      }),
    );

    clearAllResend();
  });

  it('treats transport runtimes without a provider session id as unavailable', async () => {
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: null,
      send: vi.fn(() => {
        throw new Error('TransportSessionRuntime not initialized — call initialize() first');
      }),
      pendingCount: 0,
      pendingMessages: [],
    });

    // Reset the resend queue so entries from earlier tests don't leak in.
    const { clearAllResend, getResendEntries } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'hello after restart',
      commandId: 'cmd-stale-runtime',
    }, serverLink as any);
    await flushAsync();

    // New behavior: the runtime-without-providerSessionId branch auto-resumes
    // instead of erroring. The user message is preserved, enqueued for
    // redelivery, and the command ack is `accepted` (not `error`) so the UI
    // doesn't stay stuck in a "failed send" state.
    expect(stopTransportRuntimeSessionMock).toHaveBeenCalledWith('deck_transport_brain');
    // No user.message emission on the stale-runtime queue path either —
    // the message is only in daemon memory, not yet re-dispatched. The
    // drain helper (launchTransportSession / restoreTransportSessions)
    // emits user.message when runtime.send() returns 'sent'.
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      expect.anything(),
      expect.anything(),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({
        text: expect.stringContaining('will auto-resend'),
        streaming: false,
        memoryExcluded: true,
      }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      expect.objectContaining({
        state: 'queued',
        pendingCount: 1,
        pendingMessageEntries: [
          { clientMessageId: 'cmd-stale-runtime', text: 'hello after restart' },
        ],
      }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(serverLink.send).toHaveBeenCalledWith({
      type: 'command.ack',
      commandId: 'cmd-stale-runtime',
      status: 'accepted',
      session: 'deck_transport_brain',
    });
    // The entry sits in the resend queue until the resumed runtime drains it.
    expect(getResendEntries('deck_transport_brain')).toEqual([
      expect.objectContaining({ text: 'hello after restart', commandId: 'cmd-stale-runtime' }),
    ]);
    clearAllResend();
  });

  it('tracks supervision task intents when the runtime is queued for auto-resume', async () => {
    const { clearAllResend } = await import('../../src/daemon/transport-resend-queue.js');
    clearAllResend();

    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      state: 'idle',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: null,
      send: vi.fn(() => {
        throw new Error('TransportSessionRuntime not initialized — call initialize() first');
      }),
      pendingCount: 0,
      pendingMessages: [],
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'resume supervised task',
      commandId: 'cmd-resume-supervised',
    }, serverLink as any);
    await flushAsync();

    expect(queueTaskIntentMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'cmd-resume-supervised',
      'resume supervised task',
      expect.objectContaining({
        mode: 'supervised',
        backend: 'codex-sdk',
        model: 'gpt-5.4',
      }),
    );

    clearAllResend();
  });

  it('acks an in-flight settings restart send before waiting to deliver the first transport message', async () => {
    let restartResolved = false;
    let resolveRestart: (() => void) | null = null;
    relaunchSessionWithSettingsMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRestart = () => {
          restartResolved = true;
          resolve();
        };
      }),
    );
    getSessionMock.mockImplementation(() => ({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: restartResolved ? 'claude-code-sdk' : 'claude-code',
      runtimeType: restartResolved ? 'transport' : 'process',
      state: 'idle',
    }));
    const transportSend = vi.fn(() => 'sent');
    getTransportRuntimeMock.mockImplementation(() => (
      restartResolved ? { providerSessionId: 'route-transport', send: transportSend, pendingCount: 0 } : undefined
    ));

    handleWebCommand({ type: 'session.restart', sessionName: 'deck_transport_brain', agentType: 'claude-code-sdk' }, serverLink as any);
    handleWebCommand({ type: 'session.send', session: 'deck_transport_brain', text: 'after restart', commandId: 'cmd-after-restart' }, serverLink as any);

    await flushAsync();
    expect(transportSend).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-after-restart', status: 'accepted' });

    resolveRestart?.();
    await flushAsync();
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('after restart', 'cmd-after-restart');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'user.message',
      { text: 'after restart', allowDuplicate: true, commandId: 'cmd-after-restart', clientMessageId: 'cmd-after-restart' },
      expect.objectContaining({ eventId: 'transport-user:cmd-after-restart' }),
    );
    expect(emitMock).toHaveBeenCalledWith('deck_transport_brain', 'command.ack', { commandId: 'cmd-after-restart', status: 'accepted' });
  });

  it('applies live transport-config updates to the daemon session store', async () => {
    const updatedRecord = {
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.4',
          timeoutMs: 12000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    };
    getSessionMock
      .mockReturnValueOnce({
        name: 'deck_transport_brain',
        projectName: 'transport',
        role: 'brain',
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        state: 'running',
        transportConfig: null,
      })
      .mockImplementation(() => updatedRecord as any);

    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_transport_brain',
      transportConfig: updatedRecord.transportConfig,
    }, serverLink as any);
    await flushAsync();

    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'deck_transport_brain',
      transportConfig: updatedRecord.transportConfig,
    }));
  });

  it('registers eligible supervised task messages immediately when the transport send dispatches now', async () => {
    const transportSend = vi.fn(() => 'sent');
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          auditMode: 'audit',
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'implement the feature',
      commandId: 'cmd-heavy',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('implement the feature', 'cmd-heavy');
    expect(registerTaskIntentMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'cmd-heavy',
      'implement the feature',
      expect.objectContaining({ mode: 'supervised_audit' }),
    );
    expect(queueTaskIntentMock).not.toHaveBeenCalled();
  });

  it('marks transport control-plane success messages as automation so supervision does not capture them as task completions', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'cursor-headless',
      runtimeType: 'transport',
      state: 'running',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      setAgentId,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model gpt-5.4',
      commandId: 'cmd-model-switch',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('gpt-5.4');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'assistant.text',
      expect.objectContaining({
        text: 'Switched model to gpt-5.4',
        streaming: false,
        automation: true,
        memoryExcluded: true,
      }),
      expect.any(Object),
    );
  });

  it('updates live supervision state when the browser patches transportConfig', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: null,
    });

    handleWebCommand({
      type: DAEMON_COMMAND_TYPES.SESSION_UPDATE_TRANSPORT_CONFIG,
      sessionName: 'deck_transport_brain',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
        },
      },
    }, serverLink as any);
    await flushAsync();

    expect(applySnapshotUpdateMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      expect.objectContaining({
        mode: 'supervised',
        backend: 'codex-sdk',
      }),
    );
  });

  it('does not create a heavy-mode task run for slash commands', async () => {
    const transportSend = vi.fn(() => 'sent');
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 12_000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          auditMode: 'audit',
          maxAuditLoops: 2,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/status',
      commandId: 'cmd-status',
    }, serverLink as any);
    await flushAsync();

    expect(transportSend).toHaveBeenCalledWith('/status', 'cmd-status');
    expect(queueTaskIntentMock).not.toHaveBeenCalled();
  });

  it('falls back to the normal manual send path when the persisted supervision snapshot is invalid', async () => {
    const transportSend = vi.fn(() => 'sent');
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'claude-code-sdk',
      runtimeType: 'transport',
      state: 'running',
      transportConfig: {
        supervision: {
          mode: 'supervised',
          backend: 'bad-backend',
          model: '',
          timeoutMs: 0,
          promptVersion: '',
          maxParseRetries: 0,
        },
      },
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      send: transportSend,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: 'normal message',
      commandId: 'cmd-invalid-supervision',
    }, serverLink as any);
    await flushAsync();

    expect(supervisionDecideMock).not.toHaveBeenCalled();
    expect(transportSend).toHaveBeenCalledWith('normal message', 'cmd-invalid-supervision');
  });

  it('edits a queued transport message by clientMessageId', async () => {
    const editPendingMessage = vi.fn(() => true);
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      editPendingMessage,
      sending: true,
      pendingCount: 1,
      pendingMessages: ['edited queued'],
      pendingEntries: [{ clientMessageId: 'cmd-queued', text: 'edited queued' }],
    });

    handleWebCommand({
      type: 'session.edit_queued_message',
      sessionName: 'deck_transport_brain',
      clientMessageId: 'cmd-queued',
      text: 'edited queued',
      commandId: 'cmd-edit',
    }, serverLink as any);
    await flushAsync();

    expect(editPendingMessage).toHaveBeenCalledWith('cmd-queued', 'edited queued');
    expect(updateQueuedTaskIntentMock).toHaveBeenCalledWith('deck_transport_brain', 'cmd-queued', 'edited queued');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      {
        state: 'queued',
        pendingCount: 1,
        pendingMessages: ['edited queued'],
        pendingMessageEntries: [{ clientMessageId: 'cmd-queued', text: 'edited queued' }],
      },
      expect.any(Object),
    );
  });

  it('removes a queued transport message by clientMessageId', async () => {
    const removePendingMessage = vi.fn(() => ({ clientMessageId: 'cmd-queued', text: 'queued msg' }));
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      removePendingMessage,
      sending: true,
      pendingCount: 0,
      pendingMessages: [],
      pendingEntries: [],
    });

    handleWebCommand({
      type: 'session.undo_queued_message',
      sessionName: 'deck_transport_brain',
      clientMessageId: 'cmd-queued',
      commandId: 'cmd-undo',
    }, serverLink as any);
    await flushAsync();

    expect(removePendingMessage).toHaveBeenCalledWith('cmd-queued');
    expect(removeQueuedTaskIntentMock).toHaveBeenCalledWith('deck_transport_brain', 'cmd-queued');
    expect(emitMock).toHaveBeenCalledWith(
      'deck_transport_brain',
      'session.state',
      { state: 'queued', pendingCount: 0, pendingMessages: [], pendingMessageEntries: [] },
      expect.any(Object),
    );
  });

  it('deduplicates concurrent session.restart requests for the same transport session', async () => {
    let resolveRestart: (() => void) | null = null;
    relaunchSessionWithSettingsMock.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveRestart = resolve;
      }),
    );

    handleWebCommand({ type: 'session.restart', sessionName: 'deck_transport_brain', agentType: 'claude-code-sdk' }, serverLink as any);
    handleWebCommand({ type: 'session.restart', sessionName: 'deck_transport_brain', agentType: 'claude-code-sdk' }, serverLink as any);

    await flushAsync();
    expect(relaunchSessionWithSettingsMock).toHaveBeenCalledTimes(1);

    resolveRestart?.();
    await flushAsync();
    await flushAsync();
  });

  it('skips terminal subscribe and snapshot requests for transport sessions', async () => {
    handleWebCommand({ type: 'terminal.subscribe', session: 'deck_transport_brain' }, serverLink as any);
    handleWebCommand({ type: 'terminal.snapshot_request', sessionName: 'deck_transport_brain' }, serverLink as any);
    await flushAsync();

    expect(terminalSubscribeMock).not.toHaveBeenCalled();
    expect(terminalRequestSnapshotMock).not.toHaveBeenCalled();
  });

  it('skips tmux resize for transport sessions', async () => {
    handleWebCommand({ type: 'session.resize', sessionName: 'deck_transport_brain', cols: 200, rows: 50 }, serverLink as any);
    await flushAsync();

    expect(resizeSessionMock).not.toHaveBeenCalled();
  });

  it('forwards transport approval responses to the live runtime and rebroadcasts them', async () => {
    const respondApproval = vi.fn().mockResolvedValue(undefined);
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'copilot-sdk',
      runtimeType: 'transport',
      state: 'running',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      respondApproval,
    });

    await handleWebCommand({
      type: TRANSPORT_MSG.APPROVAL_RESPONSE,
      sessionId: 'deck_transport_brain',
      requestId: 'approval-1',
      approved: true,
    }, serverLink as any);
    await flushAsync();

    expect(respondApproval).toHaveBeenCalledWith('approval-1', true);
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: TRANSPORT_MSG.APPROVAL_RESPONSE,
      sessionId: 'deck_transport_brain',
      requestId: 'approval-1',
      approved: true,
    }));
  });

  it('keeps transport approval feedback on the priority lane while a send control lock is held', async () => {
    let resolveRuntimeConfig: ((value: unknown) => void) | null = null;
    getQwenRuntimeConfigMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveRuntimeConfig = resolve;
    }));
    const setAgentId = vi.fn();
    const respondApproval = vi.fn().mockResolvedValue(undefined);
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      qwenAvailableModels: ['qwen-plus', 'qwen-max'],
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'route-transport',
      setAgentId,
      respondApproval,
      pendingCount: 0,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model qwen-max',
      commandId: 'cmd-feedback-priority-model',
    }, serverLink as any);
    await flushAsync();

    handleWebCommand({
      type: TRANSPORT_MSG.APPROVAL_RESPONSE,
      sessionId: 'deck_transport_brain',
      requestId: 'approval-priority',
      approved: false,
    }, serverLink as any);

    expect(respondApproval).toHaveBeenCalledWith('approval-priority', false);
    expect(setAgentId).not.toHaveBeenCalled();

    resolveRuntimeConfig?.({ availableModels: ['qwen-plus', 'qwen-max'] });
    await flushAsync();
    await flushAsync();
  });

  it('switches model for copilot-sdk transport sessions via /model', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'copilot-sdk',
      runtimeType: 'transport',
      state: 'running',
      requestedModel: 'gpt-5.4',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      setAgentId,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model gpt-5.4-mini',
      commandId: 'cmd-model-copilot',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('gpt-5.4-mini');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: 'gpt-5.4-mini',
      activeModel: 'gpt-5.4-mini',
      modelDisplay: 'gpt-5.4-mini',
    }));
  });

  it('switches model for gemini-sdk transport sessions via /model', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'gemini-sdk',
      runtimeType: 'transport',
      state: 'running',
      requestedModel: 'gemini-2.5-pro',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      setAgentId,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model auto',
      commandId: 'cmd-model-gemini',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('auto');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: 'auto',
      activeModel: 'auto',
      modelDisplay: 'auto',
    }));
  });

  it('switches model for kimi-sdk transport sessions via /model', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'kimi-sdk',
      runtimeType: 'transport',
      state: 'running',
      requestedModel: 'moonshot-v1-auto',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      setAgentId,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model moonshot-v1-auto,thinking',
      commandId: 'cmd-model-kimi',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('moonshot-v1-auto,thinking');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: 'moonshot-v1-auto,thinking',
      activeModel: 'moonshot-v1-auto,thinking',
      modelDisplay: 'moonshot-v1-auto,thinking',
    }));
  });

  it('switches model for cursor-headless transport sessions via /model', async () => {
    const setAgentId = vi.fn();
    getSessionMock.mockReturnValue({
      name: 'deck_transport_brain',
      projectName: 'transport',
      role: 'brain',
      agentType: 'cursor-headless',
      runtimeType: 'transport',
      state: 'running',
      requestedModel: 'gpt-5.2',
    });
    getTransportRuntimeMock.mockReturnValue({
      providerSessionId: 'provider-route-1',
      setAgentId,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_transport_brain',
      text: '/model claude-sonnet-4.6',
      commandId: 'cmd-model-cursor',
    }, serverLink as any);
    await flushAsync();

    expect(setAgentId).toHaveBeenCalledWith('claude-sonnet-4.6');
    expect(upsertSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: 'claude-sonnet-4.6',
      activeModel: 'claude-sonnet-4.6',
      modelDisplay: 'claude-sonnet-4.6',
    }));
  });

  it('reports effective daemon memory feature states including server runtime override and fallback config', async () => {
    enablePreferenceFeature();
    vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.skills), '0');

    handleWebCommand({ type: MEMORY_WS.FEATURES_QUERY, requestId: 'features-1' }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.FEATURES_RESPONSE,
      requestId: 'features-1',
      records: expect.arrayContaining([
        expect.objectContaining({ flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences, enabled: true }),
        expect.objectContaining({ flag: MEMORY_FEATURE_FLAGS_BY_NAME.skills, enabled: false }),
      ]),
    });
  });

  it('responds to MCP status queries with the six managed providers and tool family gates', async () => {
    enablePreferenceFeature();
    vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch), '1');
    getProviderMock.mockImplementation((providerId: string) => ({
      id: providerId,
      getMemoryMcpStatus: () => {
        if (
          providerId === MEMORY_MCP_PROVIDER_ID.CLAUDE_CODE_SDK
          || providerId === MEMORY_MCP_PROVIDER_ID.GEMINI_SDK
          || providerId === MEMORY_MCP_PROVIDER_ID.COPILOT_SDK
          || providerId === MEMORY_MCP_PROVIDER_ID.CODEX_SDK
          || providerId === MEMORY_MCP_PROVIDER_ID.CURSOR_HEADLESS
          || providerId === MEMORY_MCP_PROVIDER_ID.QWEN
        ) return {
          providerId,
          status: MEMORY_MCP_STATUS.READY,
          connected: true,
          degradedReasons: [],
        };
        return undefined;
      },
    }));

    handleWebCommand({ type: MEMORY_WS.MCP_STATUS_QUERY, requestId: 'mcp-status-1' }, serverLink as any);
    await flushAsync();

    const response = serverLink.send.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((message) => message.type === MEMORY_WS.MCP_STATUS_RESPONSE);
    expect(response).toMatchObject({
      type: MEMORY_WS.MCP_STATUS_RESPONSE,
      requestId: 'mcp-status-1',
      updatedAt: expect.any(Number),
      recentCalls: [],
    });
    const providers = response?.providers as Array<Record<string, unknown>>;
    expect(providers.map((provider) => provider.providerId)).toEqual([...MEMORY_MCP_PROVIDER_IDS]);
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: MEMORY_MCP_PROVIDER_ID.CLAUDE_CODE_SDK,
        status: MEMORY_MCP_STATUS.READY,
        connected: true,
        degradedReasons: [],
      }),
      expect.objectContaining({
        providerId: MEMORY_MCP_PROVIDER_ID.CODEX_SDK,
        status: MEMORY_MCP_STATUS.READY,
        connected: true,
        degradedReasons: [],
      }),
      expect.objectContaining({
        providerId: MEMORY_MCP_PROVIDER_ID.COPILOT_SDK,
        status: MEMORY_MCP_STATUS.READY,
        connected: true,
        degradedReasons: [],
      }),
      expect.objectContaining({
        providerId: MEMORY_MCP_PROVIDER_ID.GEMINI_SDK,
        status: MEMORY_MCP_STATUS.READY,
        connected: true,
        degradedReasons: [],
      }),
      expect.objectContaining({
        providerId: MEMORY_MCP_PROVIDER_ID.QWEN,
        status: MEMORY_MCP_STATUS.READY,
        connected: true,
        degradedReasons: [],
      }),
    ]));

    const toolFamilies = response?.toolFamilies as Array<Record<string, unknown>>;
    expect(toolFamilies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: MEMORY_MCP_TOOL_FAMILY.MEMORY,
        status: MEMORY_MCP_STATUS.READY,
        tools: [
          MEMORY_MCP_TOOL_NAMES.SEARCH_MEMORY,
          MEMORY_MCP_TOOL_NAMES.LIST_MEMORY_SUMMARIES,
          MEMORY_MCP_TOOL_NAMES.GET_MEMORY_SOURCES,
          MEMORY_MCP_TOOL_NAMES.SAVE_OBSERVATION,
          MEMORY_MCP_TOOL_NAMES.SAVE_PREFERENCE,
        ],
      }),
      expect.objectContaining({
        family: MEMORY_MCP_TOOL_FAMILY.SEND,
        status: MEMORY_MCP_STATUS.READY,
        tools: [
          MEMORY_MCP_TOOL_NAMES.SEND_LIST_TARGETS,
          MEMORY_MCP_TOOL_NAMES.SEND_MESSAGE,
        ],
      }),
      expect.objectContaining({
        family: MEMORY_MCP_TOOL_FAMILY.CRON,
        status: MEMORY_MCP_STATUS.READY,
        tools: [
          MEMORY_MCP_TOOL_NAMES.CRON_CREATE,
          MEMORY_MCP_TOOL_NAMES.CRON_LIST,
          MEMORY_MCP_TOOL_NAMES.CRON_UPDATE,
          MEMORY_MCP_TOOL_NAMES.CRON_DELETE,
        ],
      }),
    ]));
  });

  it('reports disconnected managed providers as unknown instead of assuming MCP readiness', async () => {
    handleWebCommand({ type: MEMORY_WS.MCP_STATUS_QUERY, requestId: 'mcp-status-disconnected' }, serverLink as any);
    await flushAsync();

    const response = serverLink.send.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((message) => message.type === MEMORY_WS.MCP_STATUS_RESPONSE);
    const providers = response?.providers as Array<Record<string, unknown>>;
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: MEMORY_MCP_PROVIDER_ID.CURSOR_HEADLESS,
        status: MEMORY_MCP_STATUS.UNKNOWN,
        connected: false,
        degradedReasons: [MEMORY_MCP_PROVIDER_STATUS_REASON.PROVIDER_NOT_CONNECTED],
      }),
    ]));
  });

  it('reports disabled MCP memory tool gates when a required memory feature is off', async () => {
    vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.quickSearch), '0');

    handleWebCommand({ type: MEMORY_WS.MCP_STATUS_QUERY, requestId: 'mcp-status-disabled' }, serverLink as any);
    await flushAsync();

    const response = serverLink.send.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .find((message) => message.type === MEMORY_WS.MCP_STATUS_RESPONSE);
    const toolFamilies = response?.toolFamilies as Array<Record<string, unknown>>;
    expect(toolFamilies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        family: MEMORY_MCP_TOOL_FAMILY.MEMORY,
        status: MEMORY_MCP_STATUS.DEGRADED,
        disabledFlag: MEMORY_MCP_DISABLED_FLAGS.QUICK_SEARCH,
        degradedReasons: expect.arrayContaining([MEMORY_MCP_DISABLED_FLAGS.QUICK_SEARCH]),
      }),
    ]));
  });

  it('applies server-managed global memory feature config ahead of local daemon config', async () => {
    vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.preferences), '0');

    handleWebCommand({
      type: MEMORY_FEATURE_CONFIG_MSG.APPLY,
      flags: {
        [MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry]: true,
        [MEMORY_FEATURE_FLAGS_BY_NAME.observationStore]: true,
        [MEMORY_FEATURE_FLAGS_BY_NAME.preferences]: true,
      },
    }, serverLink as any);

    handleWebCommand({ type: MEMORY_WS.FEATURES_QUERY, requestId: 'features-runtime-override' }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.FEATURES_RESPONSE,
      requestId: 'features-runtime-override',
      records: expect.arrayContaining([
        expect.objectContaining({
          flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
          requested: true,
          enabled: true,
          source: 'runtime_config_override',
        }),
      ]),
    }));
  });

  it('persists local fallback memory feature toggles when a direct daemon request is used', async () => {
    vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry), '0');

    handleWebCommand({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'feature-set-1',
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
      enabled: true,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: localMemoryManagementContext(),
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId: 'feature-set-1',
      success: true,
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
      requested: true,
      enabled: true,
      records: expect.arrayContaining([
        expect.objectContaining({
          flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
          requested: true,
          enabled: true,
          source: 'persisted_config',
        }),
      ]),
    }));

    serverLink.send.mockClear();
    handleWebCommand({ type: MEMORY_WS.FEATURES_QUERY, requestId: 'features-after-set' }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.FEATURES_RESPONSE,
      requestId: 'features-after-set',
      records: expect.arrayContaining([
        expect.objectContaining({
          flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
          requested: true,
          enabled: true,
          source: 'persisted_config',
        }),
      ]),
    }));
  });

  it('cascades dependencies when enabling a local fallback memory feature toggle', async () => {
    handleWebCommand({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'feature-set-dep',
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
      enabled: true,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: localMemoryManagementContext(),
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId: 'feature-set-dep',
      success: true,
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
      requested: true,
      enabled: true,
      records: expect.arrayContaining([
        expect.objectContaining({
          flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
          requested: true,
          enabled: true,
        }),
        expect.objectContaining({
          flag: MEMORY_FEATURE_FLAGS_BY_NAME.observationStore,
          requested: true,
          enabled: true,
        }),
        expect.objectContaining({
          flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
          requested: true,
          enabled: true,
          dependencyBlocked: [],
        }),
      ]),
    }));
  });

  it('reports dependency-blocked requested features when a dependency is disabled later', async () => {
    handleWebCommand({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'feature-set-pref-on',
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
      enabled: true,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: localMemoryManagementContext(),
    }, serverLink as any);
    await flushAsync();
    serverLink.send.mockClear();

    handleWebCommand({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'feature-set-ns-off',
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
      enabled: false,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: localMemoryManagementContext(),
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId: 'feature-set-ns-off',
      success: true,
      records: expect.arrayContaining([
        expect.objectContaining({
          flag: MEMORY_FEATURE_FLAGS_BY_NAME.preferences,
          requested: true,
          enabled: false,
          dependencyBlocked: expect.arrayContaining([
            MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
            MEMORY_FEATURE_FLAGS_BY_NAME.observationStore,
          ]),
        }),
      ]),
    }));
  });

  it('rejects invalid local fallback memory feature toggle requests', async () => {
    handleWebCommand({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'feature-set-invalid',
      flag: 'mem.feature.not_real',
      enabled: true,
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: localMemoryManagementContext(),
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId: 'feature-set-invalid',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.INVALID_FEATURE_FLAG,
      error: MEMORY_MANAGEMENT_ERROR_CODES.INVALID_FEATURE_FLAG,
    });
  });

  it('rejects local fallback memory feature toggles without management context', async () => {
    handleWebCommand({
      type: MEMORY_WS.FEATURES_SET,
      requestId: 'feature-set-no-context',
      flag: MEMORY_FEATURE_FLAGS_BY_NAME.namespaceRegistry,
      enabled: true,
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.FEATURES_SET_RESPONSE,
      requestId: 'feature-set-no-context',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.MANAGEMENT_REQUEST_UNROUTED,
      error: MEMORY_MANAGEMENT_ERROR_CODES.MANAGEMENT_REQUEST_UNROUTED,
    });
  });

  it('exposes trusted preference records through shared memory management messages', async () => {
    enablePreferenceFeature();
    listContextObservationsMock.mockReturnValueOnce([
      {
        id: 'pref-1',
        scope: PREFERENCE_INGEST_SCOPE,
        class: PREFERENCE_INGEST_OBSERVATION_CLASS,
        origin: PREFERENCE_INGEST_ORIGIN,
        fingerprint: 'fp-1',
        content: {
          text: 'Prefer pnpm',
          idempotencyKey: [PREFERENCE_IDEMPOTENCY_PREFIX, 'user-1', `${PREFERENCE_INGEST_SCOPE}:user-1`, 'cmd-1', 'fp-1'].join('\u0000'),
        },
        state: PREFERENCE_INGEST_OBSERVATION_STATE,
        createdAt: 10,
        updatedAt: 20,
      },
    ]);

    handleWebCommand({
      type: MEMORY_WS.PREF_QUERY,
      requestId: 'prefs-1',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-1',
        userId: 'user-1',
        role: 'user',
        source: 'server_bridge',
      },
    }, serverLink as any);
    await flushAsync();

    expect(listContextObservationsMock).toHaveBeenCalledWith({
      scope: PREFERENCE_INGEST_SCOPE,
      class: PREFERENCE_INGEST_OBSERVATION_CLASS,
    });
    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.PREF_RESPONSE,
      requestId: 'prefs-1',
      featureEnabled: true,
      records: [expect.objectContaining({
        id: 'pref-1',
        userId: 'user-1',
        text: 'Prefer pnpm',
        fingerprint: 'fp-1',
      })],
    });
  });

  it('rejects preference create while the preference feature is disabled', async () => {
    vi.stubEnv(memoryFeatureFlagEnvKey(MEMORY_FEATURE_FLAGS_BY_NAME.preferences), '0');

    handleWebCommand({ type: MEMORY_WS.PREF_CREATE, requestId: 'pref-create-disabled', text: 'Prefer pnpm' }, serverLink as any);
    await flushAsync();

    expect(writeContextObservationMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.PREF_CREATE_RESPONSE,
      requestId: 'pref-create-disabled',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED,
      error: MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED,
    });
  });

  it('refuses preference-delete messages for non-preference observation ids', async () => {
    enablePreferenceFeature();
    listContextObservationsMock.mockReturnValueOnce([]);

    handleWebCommand({
      type: MEMORY_WS.PREF_DELETE,
      requestId: 'pref-del-1',
      id: 'obs-non-pref',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-1',
        userId: 'user-1',
        role: 'user',
        source: 'server_bridge',
      },
    }, serverLink as any);
    await flushAsync();

    expect(deleteContextObservationMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.PREF_DELETE_RESPONSE,
      requestId: 'pref-del-1',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.PREFERENCE_NOT_FOUND,
      error: MEMORY_MANAGEMENT_ERROR_CODES.PREFERENCE_NOT_FOUND,
    });
  });


  it('requires expectedFromScope before promoting observations', async () => {
    enableMemoryFoundationFlags();

    handleWebCommand({
      type: MEMORY_WS.OBSERVATION_PROMOTE,
      requestId: 'obs-promote-missing-scope',
      id: 'obs-1',
      toScope: 'project_shared',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-1',
        userId: 'user-1',
        role: 'workspace_admin',
        source: 'server_bridge',
      },
    }, serverLink as any);
    await flushAsync();

    expect(promoteContextObservationMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE,
      requestId: 'obs-promote-missing-scope',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.MISSING_EXPECTED_FROM_SCOPE,
      error: MEMORY_MANAGEMENT_ERROR_CODES.MISSING_EXPECTED_FROM_SCOPE,
    });
  });

  it('rejects manual markdown ingest without canonical project identity before reading project files', async () => {
    enableMdIngestFeature();

    handleWebCommand({
      type: MEMORY_WS.MD_INGEST_RUN,
      requestId: 'md-no-project-id',
      projectDir: '/tmp/project',
      scope: 'personal',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-1',
        userId: 'user-1',
        role: 'user',
        source: 'server_bridge',
        boundProjects: [{ projectDir: '/tmp/project', canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);
    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith({
      type: MEMORY_WS.MD_INGEST_RUN_RESPONSE,
      requestId: 'md-no-project-id',
      success: false,
      featureEnabled: true,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_IDENTITY,
      error: MEMORY_MANAGEMENT_ERROR_CODES.MISSING_PROJECT_IDENTITY,
    });
  });
});
