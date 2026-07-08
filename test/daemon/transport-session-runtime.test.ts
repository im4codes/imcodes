import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TransportSessionRuntime, type PendingTransportMessage } from '../../src/agent/transport-session-runtime.js';
import { RUNTIME_TYPES } from '../../src/agent/session-runtime.js';
import { PROVIDER_ERROR_CODES, SDK_TURN_LOST_RECOVERY_STATUS, type TransportProvider, type ProviderError, type SessionConfig, type ProviderStatusUpdate, type ProviderUsageUpdate, type ToolCallEvent } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { MemorySearchResult, MemorySearchResultItem } from '../../src/context/memory-search.js';
import { PREFERENCE_CONTEXT_END, PREFERENCE_CONTEXT_START } from '../../shared/preference-ingest.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
  SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
} from '../../shared/session-control-commands.js';
import {
  SDK_TURN_LOST_RECOVERY_REASON,
  isProviderSnapshotNonBlockingForStoppedGeneration,
  readSdkTurnLostRecoveryMetadata,
  type ActivityGeneration,
  type SdkTurnLostClassifier,
  type SdkTurnLostReplayDecision,
} from '../../shared/session-activity-types.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_STATUS,
} from '../../shared/sdk-subagent-status.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());
const searchLocalMemoryMock = vi.hoisted(() => vi.fn());
const searchLocalMemorySemanticMock = vi.hoisted(() => vi.fn());

const sharedActorFixture: SharedActorEnvelope = {
  actorUserId: 'user-shared',
  actorDisplayName: 'Shared User',
  effectiveActorRole: 'participant',
  origin: 'shared-tab',
  actionId: 'action-shared',
  primaryShareId: 'share-1',
  authorizedAt: 1_000,
  queuedAt: 1_001,
  snapshot: {
    target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_test_brain' },
    effectiveRole: 'participant',
    historyCutoffAt: 900,
    authorizedAt: 1_000,
    primaryShareId: 'share-1',
    coveringShareIds: ['share-1'],
    expiresAt: null,
    nextCoverageRecheckAt: null,
  },
};

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: timelineEmitterEmitMock,
  },
}));

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: searchLocalMemoryMock,
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

// ── Mock provider factory ──────────────────────────────────────────────────────

function makeMockProvider(id = 'mock') {
  let deltaCb: ((sid: string, d: MessageDelta) => void) | null = null;
  let completeCb: ((sid: string, m: AgentMessage) => void) | null = null;
  let errorCb: ((sid: string, e: ProviderError) => void) | null = null;
  let approvalCb: ((sid: string, req: { id: string; description: string; tool?: string }) => void) | null = null;
  let statusCb: ((sid: string, status: ProviderStatusUpdate) => void) | null = null;
  let usageCb: ((sid: string, update: ProviderUsageUpdate) => void) | null = null;
  let toolCb: ((sid: string, tool: ToolCallEvent) => void) | null = null;

  const fireDelta = (sid: string) =>
    deltaCb?.(sid, { messageId: 'msg', type: 'text', delta: 'x', role: 'assistant' });
  const fireComplete = (sid: string, overrides: Partial<AgentMessage> = {}) =>
    completeCb?.(sid, {
      id: 'msg-1',
      sessionId: sid,
      kind: 'text',
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
      status: 'complete',
      ...overrides,
    } as AgentMessage);
  const fireError = (sid: string, err?: ProviderError) =>
    errorCb?.(sid, err ?? { code: 'PROVIDER_ERROR', message: 'err', recoverable: false });
  const fireApproval = (sid: string, req: { id: string; description: string; tool?: string }) =>
    approvalCb?.(sid, req);
  const fireStatus = (sid: string, status: ProviderStatusUpdate) =>
    statusCb?.(sid, status);
  const fireUsage = (sid: string, update: ProviderUsageUpdate) =>
    usageCb?.(sid, update);
  const fireTool = (sid: string, tool: ToolCallEvent) =>
    toolCb?.(sid, tool);

  return {
    provider: {
      id, connectionMode: 'persistent', sessionOwnership: 'provider',
      capabilities: { streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false, contextSupport: 'full-normalized-context-injection' },
      connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), cancel: vi.fn(),
      createSession: vi.fn().mockResolvedValue('sess-1'), endSession: vi.fn(),
      onDelta: (cb: (sid: string, d: MessageDelta) => void) => { deltaCb = cb; return () => { deltaCb = null; }; },
      onComplete: (cb: (sid: string, m: AgentMessage) => void) => { completeCb = cb; return () => { completeCb = null; }; },
      onError: (cb: (sid: string, e: ProviderError) => void) => { errorCb = cb; return () => { errorCb = null; }; },
      onApprovalRequest: (cb: (sid: string, req: { id: string; description: string; tool?: string }) => void) => { approvalCb = cb; },
      onStatus: (cb: (sid: string, status: ProviderStatusUpdate) => void) => { statusCb = cb; return () => { statusCb = null; }; },
      onUsage: (cb: (sid: string, update: ProviderUsageUpdate) => void) => { usageCb = cb; return () => { usageCb = null; }; },
      onToolCall: (cb: (sid: string, tool: ToolCallEvent) => void) => { toolCb = cb; return () => { toolCb = null; }; },
      respondApproval: vi.fn().mockResolvedValue(undefined),
    } as unknown as TransportProvider,
    fireDelta, fireComplete, fireError, fireApproval, fireStatus, fireUsage, fireTool,
  };
}

function makeSearchItem(overrides: Partial<MemorySearchResultItem> = {}): MemorySearchResultItem {
  return {
    type: 'processed',
    id: `mem-${Math.random().toString(16).slice(2, 8)}`,
    projectId: 'my-project',
    scope: 'personal',
    summary: 'Fixed a race condition in the WebSocket reconnect logic',
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    ...overrides,
  };
}

function makeSearchResult(items: MemorySearchResultItem[]): MemorySearchResult {
  return {
    items,
    stats: {
      totalRecords: items.length,
      matchedRecords: items.length,
      recentSummaryCount: items.filter((i) => i.projectionClass === 'recent_summary').length,
      durableCandidateCount: items.filter((i) => i.projectionClass === 'durable_memory_candidate').length,
      projectCount: new Set(items.map((i) => i.projectId)).size,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    },
  };
}

function sdkTurnLostError(options: {
  sessionKey?: string;
  sessionName?: string | null;
  localSessionKey?: string;
  providerSessionId?: string;
  generation?: ActivityGeneration;
  classifier?: SdkTurnLostClassifier;
  replayDecision?: SdkTurnLostReplayDecision;
} = {}): ProviderError {
  const sessionKey = options.sessionKey ?? 'deck_test_brain';
  return {
    code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
    message: 'lost turn',
    recoverable: true,
    details: {
      reason: SDK_TURN_LOST_RECOVERY_REASON,
      localSessionKey: options.localSessionKey ?? sessionKey,
      ...(options.sessionName !== null ? { sessionName: options.sessionName ?? sessionKey } : {}),
      providerId: 'codex',
      providerSessionId: options.providerSessionId ?? 'sess-1',
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      activityGeneration: options.generation ?? {
        scope: 'session',
        sessionName: sessionKey,
        generation: 1,
      },
      heartbeatFailureCount: 1,
      classifier: options.classifier ?? 'idle_missing_turn',
      recoveryAttemptId: 'recovery-1',
      correlationId: 'corr-1',
      replayDecision: options.replayDecision ?? 'pending',
    },
  };
}

const defaultConfig: SessionConfig = { sessionKey: 'deck_test_brain' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flushDispatch = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitForProviderSendCount = async (provider: ReturnType<typeof makeMockProvider>['provider'], count: number) => {
  const send = provider.send as ReturnType<typeof vi.fn>;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await flushDispatch();
    if (send.mock.calls.length >= count) return;
    await sleep(10);
  }
  expect(send.mock.calls.length).toBeGreaterThanOrEqual(count);
};

const waitForBootstrapResolverCount = async (resolvers: Array<() => void>, count: number) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await flushDispatch();
    if (resolvers.length >= count) return;
    await sleep(10);
  }
  expect(resolvers.length).toBeGreaterThanOrEqual(count);
};


// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TransportSessionRuntime', () => {
  let mock: ReturnType<typeof makeMockProvider>;
  let runtime: TransportSessionRuntime;

  beforeEach(async () => {
    resetTransportQueueStoreForTests();
    timelineEmitterEmitMock.mockReset();
    searchLocalMemoryMock.mockReset();
    searchLocalMemorySemanticMock.mockReset();
    setContextModelRuntimeConfig(null);
    mock = makeMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, 'deck_test_brain');
    await runtime.initialize(defaultConfig);
  });

  afterEach(() => {
    resetTransportQueueStoreForTests();
    vi.unstubAllEnvs();
  });

  it('type is transport', () => {
    expect(runtime.type).toBe(RUNTIME_TYPES.TRANSPORT);
  });

  it('initialize() calls provider.createSession', async () => {
    expect(runtime.providerSessionId).toBe('sess-1');
    expect(mock.provider.createSession).toHaveBeenCalledWith(defaultConfig);
  });

  it('send() throws if not initialized', () => {
    const fresh = new TransportSessionRuntime(mock.provider, 'x');
    expect(() => fresh.send('hi')).toThrow(/not initialized/i);
  });

  // Regression: the daemon drains the transport resend queue from this hook so
  // messages enqueued while the runtime was not yet ready (notably Auto-Deliver
  // prompts that took the `missing_transport_runtime` resend path) get delivered
  // instead of sitting in resend until the next restart.
  describe('onProviderSessionReady (transport resend-drain hook)', () => {
    it('fires after initialize() once the provider session is bound and send-ready', async () => {
      const fresh = new TransportSessionRuntime(mock.provider, 'deck_test_ready');
      let fired = false;
      let sessionIdAtFire: string | null = null;
      fresh.onProviderSessionReady = () => {
        fired = true;
        // Must observe a bound providerSessionId — the daemon's drain calls
        // runtime.send() synchronously, which throws if not yet initialized.
        sessionIdAtFire = fresh.providerSessionId;
      };
      expect(fired).toBe(false);
      await fresh.initialize(defaultConfig);
      expect(fired).toBe(true);
      expect(sessionIdAtFire).toBe('sess-1');
    });

    it('initialize() succeeds when no ready callback is registered', async () => {
      const fresh = new TransportSessionRuntime(mock.provider, 'deck_test_nocb');
      await expect(fresh.initialize(defaultConfig)).resolves.toBeUndefined();
      expect(fresh.providerSessionId).toBe('sess-1');
    });

    it('setProviderSessionId fires the hook only on the null→set transition', () => {
      const fresh = new TransportSessionRuntime(mock.provider, 'deck_test_setid');
      let fireCount = 0;
      fresh.onProviderSessionReady = () => { fireCount += 1; };
      fresh.setProviderSessionId('restored-1');
      expect(fireCount).toBe(1);
      // Already set → no transition → no re-fire (avoids redundant drains).
      fresh.setProviderSessionId('restored-2');
      expect(fireCount).toBe(1);
    });

    it('swallows a throwing ready callback so initialize() still resolves', async () => {
      const fresh = new TransportSessionRuntime(mock.provider, 'deck_test_throw');
      fresh.onProviderSessionReady = () => { throw new Error('boom'); };
      await expect(fresh.initialize(defaultConfig)).resolves.toBeUndefined();
      expect(fresh.providerSessionId).toBe('sess-1');
    });
  });

  it('send() returns "sent" when idle', async () => {
    expect(runtime.send('hi')).toBe('sent');
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'hi',
      assembledMessage: 'hi',
      systemText: expect.stringContaining('Use memory MCP search'),
    }));
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      systemText: expect.stringContaining('get_memory_sources'),
    }));
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      systemText: expect.stringContaining('sourceLookup fields'),
    }));
  });

  it('send() returns "queued" when busy', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    expect(runtime.send('second', 'msg-queued-2')).toBe('queued');
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.pendingMessages).toEqual(['second']);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-queued-2', text: 'second' },
    ]);
    // provider.send called only once (for first message)
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
  });

  // Stability: the transport queue is persisted to transport-queue.sqlite, but a
  // fresh daemon process starts BOTH in-memory holders empty (resend queue AND
  // the runtime's _pendingMessages). Before this fix nothing read the persisted
  // `queued` rows back, so a message queued behind an in-flight turn survived only
  // in SQLite and never drained — the daemon reported pending 0 while the row sat
  // `queued` forever. rehydratePendingFromStore() closes that read-back gap, and
  // MUST never re-dispatch work that already ran.
  describe('rehydratePendingFromStore (SQLite queue restart recovery)', () => {
    // Rebuild a runtime for the SAME session name WITHOUT resetting the (in-memory,
    // VITEST) queue store — mirrors a daemon restart where the SQLite authority
    // survives but every in-memory runtime is gone.
    const simulateRestart = async (sessionName = 'deck_test_brain') => {
      const restartMock = makeMockProvider();
      const restarted = new TransportSessionRuntime(restartMock.provider, sessionName);
      await restarted.initialize(defaultConfig);
      return { restartMock, restarted };
    };

    it('recovers a queued message that only survives in SQLite after a restart', async () => {
      runtime.send('first');
      await waitForProviderSendCount(mock.provider, 1);
      expect(runtime.send('create pr and merge to master', 'msg-stuck')).toBe('queued');

      const { restarted } = await simulateRestart();
      expect(restarted.pendingCount).toBe(0); // regression baseline: empty until rehydrate

      expect(restarted.rehydratePendingFromStore()).toBe(1);
      expect(restarted.pendingCount).toBe(1);
      expect(restarted.pendingEntries).toEqual([
        { clientMessageId: 'msg-stuck', text: 'create pr and merge to master' },
      ]);
    });

    it('drains the rehydrated message to the provider once idle', async () => {
      runtime.send('first');
      await waitForProviderSendCount(mock.provider, 1);
      runtime.send('second', 'msg-2');

      const { restartMock, restarted } = await simulateRestart();
      expect(restarted.rehydratePendingFromStore()).toBe(1);
      expect(restarted.drainPendingIfIdle('test')).toBe(true);

      await waitForProviderSendCount(restartMock.provider, 1);
      expect(restartMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        assembledMessage: expect.stringContaining('second'),
      }));
    });

    it('is idempotent — a second rehydrate does not double-recover the same id', async () => {
      runtime.send('first');
      await waitForProviderSendCount(mock.provider, 1);
      runtime.send('second', 'msg-2');

      const { restarted } = await simulateRestart();
      expect(restarted.rehydratePendingFromStore()).toBe(1);
      expect(restarted.rehydratePendingFromStore()).toBe(0); // already live → deduped
      expect(restarted.pendingCount).toBe(1);
    });

    it('does NOT recover a handoff_inflight entry (may already have executed at the provider)', async () => {
      runtime.send('first');
      await waitForProviderSendCount(mock.provider, 1);
      runtime.send('second', 'msg-2');
      // Entry was mid-dispatch (handoff lease) when the daemon died — re-sending
      // risks double execution, so it must be left for proof-backed recovery.
      getTransportQueueStore().markHandoffInFlight('deck_test_brain', ['msg-2']);

      const { restarted } = await simulateRestart();
      expect(restarted.rehydratePendingFromStore()).toBe(0);
      expect(restarted.pendingCount).toBe(0);
    });

    it('does NOT recover an already-delivered entry', async () => {
      runtime.send('first');
      await waitForProviderSendCount(mock.provider, 1);
      runtime.send('second', 'msg-2');
      // The turn actually dispatched before the crash — finalizeSent writes the
      // delivery tombstone that keeps it from resurrecting.
      getTransportQueueStore().finalizeSent('deck_test_brain', 'msg-2');

      const { restarted } = await simulateRestart();
      expect(restarted.rehydratePendingFromStore()).toBe(0);
      expect(restarted.pendingCount).toBe(0);
    });

    it('is a no-op when SQLite holds no queued entries', async () => {
      const { restarted } = await simulateRestart('deck_test_fresh');
      expect(restarted.rehydratePendingFromStore()).toBe(0);
      expect(restarted.pendingCount).toBe(0);
    });
  });

  it('places front-queued ask answers before ordinary pending messages when busy', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);

    expect(runtime.send('ordinary queued 1', 'msg-queued-1')).toBe('queued');
    expect(runtime.send('ordinary queued 2', 'msg-queued-2')).toBe('queued');
    expect(runtime.send('selected option', 'msg-ask-answer', undefined, undefined, { queuePlacement: 'front' })).toBe('queued');

    expect(runtime.pendingEntries.map((entry) => entry.clientMessageId)).toEqual([
      'msg-ask-answer',
      'msg-queued-1',
      'msg-queued-2',
    ]);
    expect(runtime.pendingMessages).toEqual([
      'selected option',
      'ordinary queued 1',
      'ordinary queued 2',
    ]);
  });

  it('queues re-entrant sends from onStatusChange while a dispatch is starting', async () => {
    let reentrantResult: 'sent' | 'queued' | null = null;
    let triggered = false;

    runtime.onStatusChange = (status) => {
      if (status === 'thinking' && !triggered) {
        triggered = true;
        reentrantResult = runtime.send('second', 'msg-status-reentrant');
      }
    };

    expect(runtime.send('first', 'msg-first')).toBe('sent');
    expect(reentrantResult).toBe('queued');
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-status-reentrant', text: 'second' },
    ]);

    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
  });

  it('direct codex-sdk long-turn probe keeps file-analysis follow-up sends queued until completion', async () => {
    const sdkMock = makeMockProvider('codex-sdk');
    const sessionName = 'deck_sdk_probe_codex_sdk_brain';
    const sdkRuntime = new TransportSessionRuntime(sdkMock.provider, sessionName);
    await sdkRuntime.initialize({
      ...defaultConfig,
      sessionKey: sessionName,
      sessionName,
      projectName: 'sdk_probe',
      cwd: process.cwd(),
      fresh: true,
    });

    let startOfTurnResult: 'sent' | 'queued' | null = null;
    let drainedEntries: PendingTransportMessage[] = [];
    let triggered = false;
    sdkRuntime.onStatusChange = (status) => {
      if (status === 'thinking' && !triggered) {
        triggered = true;
        startOfTurnResult = sdkRuntime.send('queued while thinking begins', 'msg-codex-start-reentrant');
      }
    };
    sdkRuntime.onDrain = (entries) => {
      drainedEntries = entries.map((entry) => ({ ...entry }));
    };

    const longAnalysisPrompt = [
      'Read these files, analyze the idle/queue behavior, and explain your reasoning while you work:',
      '- src/agent/transport-session-runtime.ts',
      '- src/agent/session-manager.ts',
      '- src/daemon/openspec-auto-deliver-orchestrator.ts',
      '- test/daemon/transport-session-runtime.test.ts',
      '',
      'Focus on whether a second user message can bypass the queue while this turn is still running.',
    ].join('\n');

    expect(sdkRuntime.send(longAnalysisPrompt, 'msg-codex-first')).toBe('sent');
    expect(startOfTurnResult).toBe('queued');
    expect(sdkRuntime.pendingEntries).toEqual([
      { clientMessageId: 'msg-codex-start-reentrant', text: 'queued while thinking begins' },
    ]);

    await flushDispatch();
    expect(sdkMock.provider.send).toHaveBeenCalledTimes(1);
    expect(sdkMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: longAnalysisPrompt,
    }));

    sdkMock.fireStatus('sess-1', { status: 'reading-files', label: 'Reading src/agent/transport-session-runtime.ts' });
    sdkMock.fireDelta('sess-1');
    expect(sdkRuntime.getStatus()).toBe('streaming');
    expect(sdkRuntime.send('queued while codex is reading transport runtime', 'msg-codex-reading-runtime')).toBe('queued');

    sdkMock.fireStatus('sess-1', { status: 'analyzing', label: 'Analyzing session-manager callbacks' });
    sdkMock.fireDelta('sess-1');
    expect(sdkRuntime.send('queued while codex is analyzing session manager', 'msg-codex-analyzing-session-manager')).toBe('queued');

    sdkMock.fireStatus('sess-1', { status: 'explaining', label: 'Explaining queue behavior' });
    sdkMock.fireDelta('sess-1');
    expect(sdkRuntime.send('queued while codex is explaining findings', 'msg-codex-explaining')).toBe('queued');

    expect(sdkRuntime.pendingEntries).toEqual([
      { clientMessageId: 'msg-codex-start-reentrant', text: 'queued while thinking begins' },
      { clientMessageId: 'msg-codex-reading-runtime', text: 'queued while codex is reading transport runtime' },
      { clientMessageId: 'msg-codex-analyzing-session-manager', text: 'queued while codex is analyzing session manager' },
      { clientMessageId: 'msg-codex-explaining', text: 'queued while codex is explaining findings' },
    ]);
    expect(sdkMock.provider.send).toHaveBeenCalledTimes(1);

    sdkMock.fireComplete('sess-1');
    await flushDispatch();

    expect(drainedEntries).toEqual([
      { clientMessageId: 'msg-codex-start-reentrant', text: 'queued while thinking begins' },
      { clientMessageId: 'msg-codex-reading-runtime', text: 'queued while codex is reading transport runtime' },
      { clientMessageId: 'msg-codex-analyzing-session-manager', text: 'queued while codex is analyzing session manager' },
      { clientMessageId: 'msg-codex-explaining', text: 'queued while codex is explaining findings' },
    ]);
    expect(sdkRuntime.pendingCount).toBe(0);
    expect(sdkMock.provider.send).toHaveBeenCalledTimes(2);
    expect(sdkMock.provider.send).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
      userMessage: [
        'queued while thinking begins',
        'queued while codex is reading transport runtime',
        'queued while codex is analyzing session manager',
        'queued while codex is explaining findings',
      ].join('\n\n'),
    }));

    await sdkRuntime.kill();
  });

  it('send() queues when any active-turn marker is present, even if the sending flag is stale', async () => {
    runtime.send('first', 'msg-active-1');
    await flushDispatch();

    const internal = runtime as unknown as {
      _sending: boolean;
    };
    internal._sending = false;

    expect(runtime.send('second', 'msg-active-2')).toBe('queued');
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-active-2', text: 'second' },
    ]);
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
  });

  it('diagnostic snapshot exposes active dispatch and pending queue state', async () => {
    const providerDiagnostics = {
      provider: 'mock',
      runningTurnId: 'turn-1',
      activeItemCount: 1,
      customProviderField: false,
    };
    (mock.provider as TransportProvider).getSessionDiagnostics = vi.fn().mockReturnValue(providerDiagnostics);

    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('second', 'cmd-second');

    const snapshot = runtime.getDiagnosticSnapshot(runtime.lastActivityAt + 250);
    expect(snapshot).toMatchObject({
      status: 'thinking',
      sending: true,
      pendingCount: 1,
      activeDispatchCount: 1,
      stalePendingRecoveryActive: false,
      providerSessionBound: true,
      providerDiagnostics,
      lastActivityAgeMs: 250,
    });
    expect(mock.provider.getSessionDiagnostics).toHaveBeenCalledWith('sess-1');
    expect(snapshot.pendingVersion).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['Claude task', SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK, SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK],
    ['Claude runtime', SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK, SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT],
    ['Codex runtime', SDK_SUBAGENT_PROVIDERS.CODEX_SDK, SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT],
    ['Qwen runtime', SDK_SUBAGENT_PROVIDERS.QWEN, SDK_SUBAGENT_PROVIDER_KINDS.QWEN_RUNTIME_AGENT],
    ['Gemini runtime', SDK_SUBAGENT_PROVIDERS.GEMINI_SDK, SDK_SUBAGENT_PROVIDER_KINDS.GEMINI_RUNTIME_AGENT],
  ] as const)('treats backgrounded %s SDK sub-agent heartbeats as non-blocking display state', async (_label, provider, providerKind) => {
    runtime.send('spawn a long helper', 'cmd-parent');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireComplete('sess-1');
    await flushDispatch();
    expect(runtime.getStatus()).toBe('idle');

    const backgroundedSubagentTool: ToolCallEvent = {
      id: `${provider}:deck_test_brain:runtime:019f-child`,
      name: 'SDK Sub-agent',
      status: 'running',
      input: { action: 'sdk-subagent', description: 'sleep 600' },
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        schemaVersion: 1,
        provider,
        status: SDK_SUBAGENT_STATUS.RUNNING,
        label: 'SDK Sub-agent running',
        meta: {
          isSdkSubagent: true,
          schemaVersion: 1,
          provider,
          providerKind,
          canonicalKey: `${provider}:deck_test_brain:runtime:019f-child`,
          agentPath: '019f-child',
          rawStatus: 'running',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
          backgrounded: true,
        },
      },
    };

    mock.fireTool('sess-1', backgroundedSubagentTool);
    await flushDispatch();
    expect((runtime as unknown as { _openTools: Map<string, unknown> })._openTools.size).toBe(0);

    await runtime.cancel();
    expect(mock.provider.cancel).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toBe('idle');

    expect(runtime.send('next user message', 'cmd-after-subagent-heartbeat')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 2);
    expect(runtime.pendingEntries).toEqual([]);
  });

  it('closes runtime-local open tools on provider completion so idle and queued drain are not blocked', async () => {
    runtime.send('run a short tool', 'cmd-tool-parent');
    await waitForProviderSendCount(mock.provider, 1);

    mock.fireTool('sess-1', {
      id: 'tool-stuck-open',
      name: 'Bash',
      status: 'running',
      input: { command: 'true' },
    });
    await flushDispatch();
    expect((runtime as unknown as { _openTools: Map<string, unknown> })._openTools.size).toBe(1);

    expect(runtime.send('next queued message', 'cmd-after-tool-complete')).toBe('queued');
    mock.fireComplete('sess-1');
    await waitForProviderSendCount(mock.provider, 2);

    expect((runtime as unknown as { _openTools: Map<string, unknown> })._openTools.size).toBe(0);
    expect(runtime.pendingEntries).toEqual([]);
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-stuck-open',
        tool: 'Bash',
        terminalStatus: 'succeeded',
        terminalReason: 'provider_result',
      }),
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
  });

  it('diagnostic snapshot keeps the latest provider error for recovery debugging', async () => {
    runtime.send('fail this turn', 'cmd-fail');
    await waitForProviderSendCount(mock.provider, 1);

    const beforeError = Date.now();
    mock.fireError('sess-1', {
      code: 'PROVIDER_ERROR',
      message: 'raw provider failure',
      recoverable: false,
    });

    expect(runtime.getDiagnosticSnapshot().lastProviderError).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'raw provider failure',
      recoverable: false,
    });
    expect(runtime.getDiagnosticSnapshot().lastProviderError?.at).toBeGreaterThanOrEqual(beforeError);
  });

  it('treats provider status, usage, and approval callbacks as turn liveness evidence', async () => {
    const internal = runtime as unknown as {
      _lastActivityAt: number;
    };

    internal._lastActivityAt = 1_000;
    mock.fireStatus('sess-1', { status: 'thinking', label: 'Thinking...' });
    expect(runtime.lastActivityAt).toBeGreaterThan(1_000);

    internal._lastActivityAt = 1_000;
    mock.fireUsage('sess-1', { usage: { input_tokens: 10 }, model: 'test-model' });
    expect(runtime.lastActivityAt).toBeGreaterThan(1_000);

    const approvals: Array<Record<string, unknown>> = [];
    runtime.onApprovalRequest = (request) => approvals.push(request as unknown as Record<string, unknown>);
    internal._lastActivityAt = 1_000;
    mock.fireApproval('sess-1', { id: 'approval-1', description: 'Allow tool?', tool: 'shell' });
    expect(runtime.lastActivityAt).toBeGreaterThan(1_000);
    expect(approvals).toEqual([
      { id: 'approval-1', description: 'Allow tool?', tool: 'shell' },
    ]);

    internal._lastActivityAt = 1_000;
    mock.fireStatus('other-session', { status: 'thinking', label: 'Wrong session' });
    mock.fireUsage('other-session', { usage: { input_tokens: 99 } });
    mock.fireApproval('other-session', { id: 'approval-other', description: 'Wrong session' });
    expect(runtime.lastActivityAt).toBe(1_000);
    expect(approvals).toHaveLength(1);
  });

  it('bumps pendingVersion monotonically on every queue mutation (desync guard)', async () => {
    // The UI uses this monotonic version to drop stale out-of-order snapshots.
    // Every mutation MUST advance it so a late pre-mutation snapshot is rejected.
    expect(runtime.pendingVersion).toBe(0);

    runtime.send('first'); // dispatched immediately (idle) — not a queue mutation
    await flushDispatch();
    expect(runtime.pendingVersion).toBe(0);

    // enqueue while busy → bump
    runtime.send('second', 'q2');
    runtime.send('third', 'q3');
    expect(runtime.pendingVersion).toBe(2);
    expect(runtime.pendingCount).toBe(2);

    // edit → bump
    expect(runtime.editPendingMessage('q2', 'second edited')).toBe(true);
    expect(runtime.pendingVersion).toBe(3);

    // remove → bump
    expect(runtime.removePendingMessage('q3')).not.toBeNull();
    expect(runtime.pendingVersion).toBe(4);

    // no-op edit/remove (unknown id) → NO bump
    expect(runtime.editPendingMessage('nope', 'x')).toBe(false);
    expect(runtime.removePendingMessage('nope')).toBeNull();
    expect(runtime.pendingVersion).toBe(4);

    // drain on turn completion → bump (queue empties, one entry 'q2' left)
    mock.fireComplete('sess-1');
    await flushDispatch();
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.pendingVersion).toBe(5);
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'transport.queue.delivery',
      expect.objectContaining({
        type: 'transport.queue.delivery',
        sessionName: 'deck_test_brain',
        clientMessageId: 'q2',
        queueEpoch: expect.any(String),
        queueAuthorityId: expect.any(String),
        pendingMessageVersion: expect.any(Number),
        deliveryFrameId: expect.any(String),
        deliveryFrameVersion: expect.any(Number),
      }),
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
  });

  it('fails closed on provider active/stale snapshots and drains after current-clear without Stop', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued while provider active', 'cmd-queued');

    let snapshotMode: 'active' | 'stale' | 'clear' = 'active';
    const currentGeneration = { scope: 'session' as const, sessionName: 'deck_test_brain', generation: 1 };
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => {
      if (snapshotMode === 'active') {
        return {
          status: 'current',
          activeWorkCount: 1,
          activeToolCount: 1,
          busyReasons: ['provider_tool_item'],
          generation: currentGeneration,
          updatedAt: Date.now(),
        };
      }
      if (snapshotMode === 'stale') {
        return {
          status: 'stale',
          activeWorkCount: 0,
          activeToolCount: 0,
          busyReasons: [],
          generation: currentGeneration,
          updatedAt: Date.now() - 60_000,
        };
      }
      return {
        status: 'current',
        activeWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
        generation: currentGeneration,
        updatedAt: Date.now(),
      };
    });

    mock.fireComplete('sess-1');
    await flushDispatch();
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.getStatus()).toBe('tool_running');
    expect(runtime.getDiagnosticSnapshot().busyReasons).toContain('provider_tool_item');

    snapshotMode = 'stale';
    expect(runtime.drainPendingIfIdle('health-poll-stale')).toBe(false);
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.getDiagnosticSnapshot().busyReasons).toContain('snapshot_stale');

    snapshotMode = 'clear';
    expect(runtime.drainPendingIfIdle('health-poll-clear')).toBe(true);
    await waitForProviderSendCount(mock.provider, 2);
    expect(runtime.pendingCount).toBe(0);
  });

  it('treats session-local stale provider generation as blocking evidence', async () => {
    runtime.send('first generation turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 0 },
      updatedAt: Date.now(),
    }));
    const snapshot = runtime.getDiagnosticSnapshot();
    expect(snapshot.blockingWorkCount).toBeGreaterThan(0);
    expect(snapshot.busyReasons).toContain('snapshot_stale');
  });

  it('does not let a zero-work old-generation snapshot block a settled runtime without Stop', async () => {
    runtime.send('first generation turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireComplete('sess-1');
    await flushDispatch();
    expect(runtime.getStatus()).toBe('idle');

    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 0 },
      updatedAt: Date.now(),
    }));

    const settledSnapshot = runtime.getDiagnosticSnapshot();
    expect(settledSnapshot.blockingWorkCount).toBe(0);
    expect(settledSnapshot.busyReasons).not.toContain('snapshot_stale');

    expect(runtime.send('second generation turn', 'cmd-second')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'second generation turn',
      assembledMessage: 'second generation turn',
    }));
  });

  it('fails closed when provider clear snapshot lacks current runtime attribution', async () => {
    runtime.send('first generation turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      providerDiagnosticGeneration: 'codex-turn-1',
      updatedAt: Date.now(),
    }));
    const snapshot = runtime.getDiagnosticSnapshot();
    expect(snapshot.blockingWorkCount).toBeGreaterThan(0);
    expect(snapshot.busyReasons).toContain('snapshot_unavailable');
  });

  it('fails closed when provider active-work snapshot throws', async () => {
    runtime.send('first generation turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => {
      throw new Error('SECRET_PROVIDER_PAYLOAD');
    });
    const snapshot = runtime.getDiagnosticSnapshot();
    expect(snapshot.blockingWorkCount).toBeGreaterThan(0);
    expect(snapshot.busyReasons).toContain('snapshot_error');
  });

  it('does not let an unattributed pre-dispatch clear snapshot block the first send', async () => {
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      providerDiagnosticGeneration: 'codex-before-first-turn',
      updatedAt: Date.now(),
    }));

    runtime.send('first turn must dispatch', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);

    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
      userMessage: 'first turn must dispatch',
      activityGeneration: {
        scope: 'session',
        sessionName: 'deck_test_brain',
        generation: 1,
      },
    });
  });

  it('attaches runtime activityGeneration to provider payloads', async () => {
    runtime.send('turn with generation', 'cmd-gen');
    await waitForProviderSendCount(mock.provider, 1);
    const payload = mock.provider.send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.activityGeneration).toMatchObject({
      scope: 'session',
      sessionName: 'deck_test_brain',
      generation: 1,
    });
  });

  it('emits an abandoned synthetic tool terminal when dispatch generation rolls over', async () => {
    runtime.send('first generation turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireTool('sess-1', {
      id: 'tool-old',
      name: 'Bash',
      status: 'running',
    });
    expect(runtime.getDiagnosticSnapshot().activeToolCount).toBe(1);

    const internal = runtime as unknown as {
      _dispatchTurn: (message: string, clientMessageId?: string) => void;
    };
    internal._dispatchTurn('second generation turn', 'cmd-second');
    await waitForProviderSendCount(mock.provider, 2);

    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-old',
        tool: 'Bash',
        terminalStatus: 'abandoned',
        terminalReason: 'generation_rollover',
        activityGeneration: {
          scope: 'session',
          sessionName: 'deck_test_brain',
          generation: 1,
        },
      }),
      expect.objectContaining({
        source: 'daemon',
        confidence: 'high',
        eventId: expect.stringContaining('tool-old:abandoned:generation_rollover'),
      }),
    );
  });

  it('emits clean idle when provider completion closes the last open tool', async () => {
    const statuses: string[] = [];
    runtime.onStatusChange = (status) => {
      statuses.push(status);
    };

    runtime.send('turn with background tool', 'cmd-tool-idle');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireTool('sess-1', {
      id: 'tool-background',
      name: 'Agent',
      status: 'running',
    });
    mock.fireComplete('sess-1');
    await flushDispatch();

    expect(runtime.getDiagnosticSnapshot().blockingWorkCount).toBe(0);
    expect(runtime.getDiagnosticSnapshot().busyReasons).not.toContain('open_tool_call');
    expect(statuses.at(-1)).toBe('idle');

    mock.fireTool('sess-1', {
      id: 'tool-background',
      name: 'Agent',
      status: 'complete',
    });
    await flushDispatch();

    expect(runtime.getDiagnosticSnapshot().blockingWorkCount).toBe(0);
    expect(statuses.at(-1)).toBe('idle');
  });

  it('injects stable preference context only once per provider conversation', async () => {
    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Use pnpm\n${PREFERENCE_CONTEXT_END}`;

    runtime.send('first preference-aware turn', 'pref-once-1', undefined, preferencePreamble);
    await flushDispatch();
    mock.fireComplete('sess-1');
    await flushDispatch();

    runtime.send('second preference-aware turn', 'pref-once-2', undefined, preferencePreamble);
    await flushDispatch();

    const firstPayload = mock.provider.send.mock.calls[0]?.[1] as Record<string, unknown>;
    const secondPayload = mock.provider.send.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(firstPayload.messagePreamble).toContain('Use pnpm');
    expect(String(firstPayload.assembledMessage)).toContain('Use pnpm');
    expect(secondPayload.messagePreamble).toBeUndefined();
    expect(secondPayload.assembledMessage).toBe('second preference-aware turn');
  });

  it('does not attach preference context to control messages and re-injects it after compaction', async () => {
    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Use pnpm\n${PREFERENCE_CONTEXT_END}`;

    runtime.send('first preference-aware turn', 'pref-compact-1', undefined, preferencePreamble);
    await flushDispatch();
    mock.fireComplete('sess-1');
    await flushDispatch();

    runtime.send('/compact', 'pref-compact-control', undefined, preferencePreamble);
    await flushDispatch();
    const compactPayload = mock.provider.send.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(compactPayload.userMessage).toBe('/compact');
    expect(compactPayload.messagePreamble).toBeUndefined();
    expect(compactPayload.assembledMessage).toBe('/compact');

    mock.fireComplete('sess-1', {
      kind: 'system',
      role: 'system',
      content: 'Codex context compacted.',
      metadata: { provider: 'codex-sdk', [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact' },
    });
    await flushDispatch();

    runtime.send('after compact', 'pref-compact-2', undefined, preferencePreamble);
    await flushDispatch();
    const afterCompactPayload = mock.provider.send.mock.calls[2]?.[1] as Record<string, unknown>;
    expect(afterCompactPayload.messagePreamble).toContain('Use pnpm');
    expect(String(afterCompactPayload.assembledMessage)).toContain('Use pnpm');
  });

  it('emits a visible timeline block when /compact starts dispatching', async () => {
    expect(runtime.send('/compact', 'compact-block-1')).toBe('sent');

    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'session.state',
      {
        state: SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
        reason: SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
      },
      { source: 'daemon', confidence: 'high' },
    );
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: '/compact',
    }));
  });

  it('rejects /compact before dispatch when provider compact capability is unsupported', () => {
    (mock.provider.capabilities as Record<string, unknown>).compact = {
      execution: 'unsupported',
      verified: false,
      completion: 'none',
      cancellation: 'none',
      reason: 'mock provider does not support compact',
    };

    expect(() => runtime.send('/compact')).toThrow('mock provider does not support compact');
    expect(mock.provider.send).not.toHaveBeenCalled();
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith(
      'deck_test_brain',
      'session.state',
      expect.objectContaining({ state: SESSION_CONTROL_TIMELINE_STATE_COMPACTING }),
      expect.anything(),
    );
  });

  it('keeps slash controls raw for every transport by suppressing startup, recall, authored, and preference context', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory: {
        reason: 'startup',
        runtimeFamily: 'transport',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectionSurface: 'normalized-payload',
        items: [makeSearchItem({ id: 'startup-memory', summary: 'Startup memory must not ride with slash controls' })],
        injectedText: 'Historical context that must not be attached to /compact',
      } as any,
    }));
    await r.initialize({
      ...defaultConfig,
      description: 'Session description must not be attached to /compact',
      systemPrompt: 'Runtime system prompt must not be attached to /compact',
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });
    timelineEmitterEmitMock.mockClear();
    searchLocalMemorySemanticMock.mockClear();

    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Prefer pnpm\n${PREFERENCE_CONTEXT_END}`;
    r.send('/compact', 'raw-compact-control', undefined, preferencePreamble);
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    const compactPayload = localMock.provider.send.mock.calls[0]?.[1] as Record<string, any>;
    expect(compactPayload.userMessage).toBe('/compact');
    expect(compactPayload.assembledMessage).toBe('/compact');
    expect(compactPayload.systemText).toBeUndefined();
    expect(compactPayload.messagePreamble).toBeUndefined();
    expect(compactPayload.startupMemory).toBeUndefined();
    expect(compactPayload.memoryRecall).toBeUndefined();
    expect(compactPayload.context?.systemText).toBeUndefined();
    expect(compactPayload.context?.messagePreamble).toBeUndefined();
    expect(compactPayload.context?.requiredAuthoredContext).toEqual([]);
    expect(compactPayload.context?.advisoryAuthoredContext).toEqual([]);
  });

  it('keeps queued preference context in messagePreamble without changing user-visible text', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    const preferencePreamble = `${PREFERENCE_CONTEXT_START}\n- Use pnpm\n${PREFERENCE_CONTEXT_END}`;
    expect(runtime.send('second', 'msg-queued-2', undefined, preferencePreamble)).toBe('queued');

    expect(runtime.pendingMessages).toEqual(['second']);
    // RV-B: the PUBLIC projection (diagnostics / status / UI) keeps only the
    // user-visible text; the secret per-turn `messagePreamble` is NOT exposed.
    expect(runtime.pendingEntries).toEqual([
      {
        clientMessageId: 'msg-queued-2',
        text: 'second',
      },
    ]);
    expect(runtime.pendingEntries[0]).not.toHaveProperty('messagePreamble');
    // The internal resend view still carries the preamble (delivery/preservation).
    expect(runtime.pendingEntriesForResend).toEqual([
      {
        clientMessageId: 'msg-queued-2',
        text: 'second',
        messagePreamble: preferencePreamble,
      },
    ]);

    mock.fireComplete('sess-1');
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'second',
      assembledMessage: expect.stringContaining('Use pnpm'),
      messagePreamble: expect.stringContaining('Use pnpm'),
    }));
  });

  it('exposes the active dispatch payload during error status, then clears local active state', async () => {
    let activeEntriesDuringError: PendingTransportMessage[] | undefined;
    runtime.onStatusChange = (status) => {
      if (status === 'error') {
        activeEntriesDuringError = runtime.activeDispatchEntries;
      }
    };

    runtime.send('retry me', 'msg-retry');
    await flushDispatch();

    expect(runtime.activeDispatchEntries).toEqual([
      { clientMessageId: 'msg-retry', text: 'retry me' },
    ]);

    mock.fireError('sess-1', {
      code: PROVIDER_ERROR_CODES.CONNECTION_LOST,
      message: 'connection lost',
      recoverable: false,
    });
    expect(activeEntriesDuringError).toEqual([
      { clientMessageId: 'msg-retry', text: 'retry me' },
    ]);
    expect(runtime.activeDispatchEntries).toEqual([]);
  });

  it('clears active dispatch state after an async provider send failure', async () => {
    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 'TRANSPORT_TURN_TIMEOUT',
      message: 'provider did not accept the turn',
      recoverable: false,
    });

    runtime.send('timeout once', 'msg-timeout');
    await flushDispatch();

    expect(runtime.getStatus()).toBe('error');
    expect(runtime.sending).toBe(false);
    expect(runtime.activeDispatchEntries).toEqual([]);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toMatchObject({
      code: 'TRANSPORT_TURN_TIMEOUT',
      message: 'provider did not accept the turn',
      recoverable: false,
    });
  });

  it('auto-retries a recoverable async send failure instead of dropping the turn', async () => {
    // A recoverable DELIVERY failure (provider.send rejects, e.g. "provider
    // busy") must NOT stop the turn or strand the UI: the failed message is
    // re-queued and the session shows in-progress (thinking) while an auto-retry
    // is scheduled. Only the active-dispatch scratch state is cleared.
    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'temporary provider refusal',
      recoverable: true,
    });

    runtime.send('recoverable refusal', 'msg-recoverable');
    await flushDispatch();

    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.sending).toBe(false);
    expect(runtime.activeDispatchEntries).toEqual([]);
    // Re-queued (not dropped) for auto-retry; the session counts as busy so
    // later sends queue in order behind it.
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.pendingMessages).toEqual(['recoverable refusal']);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'temporary provider refusal',
      recoverable: true,
    });
  });

  it('auto-retry redelivers a recoverable-failed message once the provider frees up', async () => {
    // The first provider.send rejects with a recoverable "busy" error; the
    // runtime must re-queue and auto-retry, and the next attempt (provider now
    // free) must actually DELIVER the message — the turn completes rather than
    // silently stopping or stranding the frontend.
    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'provider is already busy',
      recoverable: true,
    });

    runtime.send('deliver me', 'msg-retry');
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.pendingCount).toBe(1);

    // The backoff retry fires and redelivers to the now-free provider.
    await waitForProviderSendCount(mock.provider, 2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'deliver me',
    }));
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
  });

  it('auto-retry of a direct send does not duplicate timeline drain or runtime history', async () => {
    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'Codex SDK session is already busy',
      recoverable: true,
    });
    const drains: PendingTransportMessage[][] = [];
    runtime.onDrain = (entries) => {
      drains.push(entries.map((entry) => ({ ...entry })));
    };

    expect(runtime.send('direct busy retry', 'msg-direct-busy')).toBe('sent');
    await flushDispatch();

    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-direct-busy', text: 'direct busy retry' },
    ]);
    expect(runtime.getHistory().filter((entry) => entry.role === 'user').map((entry) => entry.content)).toEqual([
      'direct busy retry',
    ]);

    await waitForProviderSendCount(mock.provider, 2);

    // The command handler already rendered direct sends when send() returned
    // "sent"; retry-drain must not emit a second visible user event.
    expect(drains).toEqual([[]]);
    expect(runtime.getHistory().filter((entry) => entry.role === 'user').map((entry) => entry.content)).toEqual([
      'direct busy retry',
    ]);
    expect(runtime.pendingEntries).toEqual([]);
  });

  it('auto-retry of a drained queued turn emits its user event only once', async () => {
    const drains: PendingTransportMessage[][] = [];
    runtime.onDrain = (entries) => {
      drains.push(entries.map((entry) => ({ ...entry })));
    };

    expect(runtime.send('active turn', 'msg-active')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    expect(runtime.send('queued busy retry', 'msg-queued-busy')).toBe('queued');

    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'Codex SDK session is already busy',
      recoverable: true,
    });
    mock.fireComplete('sess-1');
    await flushDispatch();

    expect(drains).toEqual([
      [{ clientMessageId: 'msg-queued-busy', text: 'queued busy retry' }],
    ]);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-queued-busy', text: 'queued busy retry' },
    ]);

    (runtime as unknown as { _lastProviderOutputAt: number })._lastProviderOutputAt = Date.now() - 10_000;
    await waitForProviderSendCount(mock.provider, 3);

    expect(drains).toEqual([
      [{ clientMessageId: 'msg-queued-busy', text: 'queued busy retry' }],
      [],
    ]);
    expect(runtime.getHistory().filter((entry) => entry.role === 'user').map((entry) => entry.content)).toEqual([
      'active turn',
      'queued busy retry',
    ]);
    expect(runtime.pendingEntries).toEqual([]);
  });

  it('preserves active messages in the pending queue when stale busy exhausts retry budget', async () => {
    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'Codex SDK session is already busy',
      recoverable: true,
    });

    expect(runtime.send('wedged busy turn', 'msg-wedged-busy')).toBe('sent');
    // Force the next recoverable busy failure to be treated as budget
    // exhausted without spending 15 real backoff cycles.
    (runtime as unknown as { _recoverableDispatchRetries: number })._recoverableDispatchRetries = 15;
    await flushDispatch();

    expect(runtime.getStatus()).toBe('error');
    expect(runtime.activeDispatchEntries).toEqual([]);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-wedged-busy', text: 'wedged busy turn' },
    ]);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'Codex SDK session is already busy',
      recoverable: true,
    });
  });

  it('uses a short retry budget for stale provider busy instead of the generic recoverable budget', async () => {
    const send = mock.provider.send as ReturnType<typeof vi.fn>;
    send.mockRejectedValue({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'Codex SDK session is already busy',
      recoverable: true,
    });

    expect(runtime.send('stale busy should relaunch quickly', 'msg-short-busy')).toBe('sent');
    for (let expectedCalls = 1; expectedCalls <= 4; expectedCalls++) {
      if (expectedCalls > 1) {
        (runtime as unknown as { _lastProviderOutputAt: number })._lastProviderOutputAt = Date.now() - 10_000;
        await waitForProviderSendCount(mock.provider, expectedCalls);
      } else {
        await flushDispatch();
      }
    }
    await flushDispatch();

    expect(send).toHaveBeenCalledTimes(4);
    expect(runtime.getStatus()).toBe('error');
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-short-busy', text: 'stale busy should relaunch quickly' },
    ]);
  });

  it('STOP during an auto-retry interrupts only the retried turn and keeps later-queued messages', async () => {
    // Regression (audit Medium): STOP must NOT clear the whole queue during an
    // auto-retry. Only the turn being retried is dropped; messages the user
    // queued AFTER it survive and are delivered.
    (mock.provider.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message: 'provider is already busy',
      recoverable: true,
    });
    runtime.send('being retried', 'msg-a');
    await flushDispatch();
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.pendingCount).toBe(1);

    // User queues another message behind the one being retried.
    runtime.send('queued after stop', 'msg-b');
    expect(runtime.pendingCount).toBe(2);

    // STOP during the retry backoff: 'being retried' is dropped, but 'queued
    // after stop' is preserved and delivered (the provider is free now).
    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after stop',
    }));
    expect(runtime.pendingMessages).not.toContain('being retried');
    expect(runtime.pendingCount).toBe(0);
  });

  it('safe sdk_turn_lost replay preserves batch identity, attachments, shared actor metadata, and committed flags', async () => {
    const drains: Array<{ entries: PendingTransportMessage[]; metadataEntries: unknown[] }> = [];
    runtime.onDrain = (entries, _merged, _count, metadata) => {
      drains.push({
        entries: entries.map((entry) => ({ ...entry })),
        metadataEntries: metadata.entries,
      });
    };

    expect(runtime.send('active turn', 'msg-active')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    const attachment = { id: 'att-1', daemonPath: '/tmp/one.png', originalName: 'one.png', type: 'image' as const };
    expect(runtime.send('queued with attachment', 'msg-queued-a', [attachment], undefined, {
      sharedActor: sharedActorFixture,
    })).toBe('queued');
    expect(runtime.send('queued plain', 'msg-queued-b')).toBe('queued');

    mock.fireComplete('sess-1');
    await waitForProviderSendCount(mock.provider, 2);

    expect(drains).toHaveLength(1);
    expect(drains[0]?.entries.map((entry) => entry.clientMessageId)).toEqual(['msg-queued-a', 'msg-queued-b']);
    expect(drains[0]?.metadataEntries).toEqual([
      expect.objectContaining({
        clientMessageId: 'msg-queued-a',
        attachmentIds: ['att-1'],
        actorSessionName: 'deck_test_brain',
        sharedActionId: 'action-shared',
      }),
      expect.objectContaining({ clientMessageId: 'msg-queued-b' }),
    ]);
    expect(runtime.getHistory().filter((entry) => entry.role === 'user').map((entry) => entry.content)).toEqual([
      'active turn',
      'queued with attachment\n\nqueued plain',
    ]);

    mock.fireError('sess-1', sdkTurnLostError({
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 2 },
    }));
    await waitForProviderSendCount(mock.provider, 3);

    expect(drains).toHaveLength(2);
    expect(drains[1]?.entries).toEqual([]);
    expect(runtime.getHistory().filter((entry) => entry.role === 'user').map((entry) => entry.content)).toEqual([
      'active turn',
      'queued with attachment\n\nqueued plain',
    ]);
    const replayPayload = mock.provider.send.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(replayPayload).toMatchObject({
      userMessage: 'queued with attachment\n\nqueued plain',
      activityGeneration: { scope: 'session', sessionName: 'deck_test_brain', generation: 3 },
    });
    expect(replayPayload.attachments).toEqual([attachment]);
  });

  it('handles rejected sdk_turn_lost as typed recovery without generic error pollution', async () => {
    (mock.provider.send as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(sdkTurnLostError())
      .mockResolvedValueOnce(undefined);

    expect(runtime.send('lost before callback', 'msg-reject-lost')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 2);

    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    expect(runtime.getStatus()).toBe('thinking');
    const phaseCalls = timelineEmitterEmitMock.mock.calls
      .filter((call) => call[0] === 'deck_test_brain' && call[1] === 'agent.status')
      .map((call) => (call[2] as Record<string, unknown>).phase);
    expect(phaseCalls).toContain('detected');
    expect(phaseCalls).toContain('recovering');
    expect(phaseCalls).not.toContain('recovered');
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'lost before callback',
      activityGeneration: { scope: 'session', sessionName: 'deck_test_brain', generation: 2 },
    }));
  });

  it('accepts Codex sdk_turn_lost metadata keyed by provider route id when sessionName matches runtime', async () => {
    expect(runtime.send('lost route-keyed turn', 'msg-route-keyed')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);

    mock.fireError('sess-1', sdkTurnLostError({
      localSessionKey: 'codex-provider-route-id',
      sessionKey: 'deck_test_brain',
      providerSessionId: 'sess-1',
    }));
    await waitForProviderSendCount(mock.provider, 2);

    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    expect(runtime.getStatus()).toBe('thinking');
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'lost route-keyed turn',
      activityGeneration: { scope: 'session', sessionName: 'deck_test_brain', generation: 2 },
    }));
    expect(runtime.activeDispatchEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-route-keyed']);
    const phaseCalls = timelineEmitterEmitMock.mock.calls
      .filter((call) => call[0] === 'deck_test_brain' && call[1] === 'agent.status')
      .map((call) => (call[2] as Record<string, unknown>).phase);
    expect(phaseCalls).toEqual(expect.arrayContaining(['detected', 'recovering']));
  });

  it('ignores sdk_turn_lost metadata for another runtime without recording a generic provider error', async () => {
    expect(runtime.send('active turn', 'msg-active-other-runtime')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);

    mock.fireError('sess-1', sdkTurnLostError({
      localSessionKey: 'other-session',
      sessionName: 'other-session',
      providerSessionId: 'other-provider-session',
    }));
    await sleep(25);

    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.activeDispatchEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-active-other-runtime']);
  });

  it('emits recovered only after replacement dispatch is accepted and produces post-acceptance strong activity', async () => {
    expect(runtime.send('lost active turn', 'msg-lost-active')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);

    mock.fireError('sess-1', sdkTurnLostError());
    // A late old-turn delta before the replacement dispatch has been accepted
    // must not be queued and reclassified as recovered later.
    mock.fireDelta('sess-1');
    await waitForProviderSendCount(mock.provider, 2);

    const phasesBeforeReplacementActivity = timelineEmitterEmitMock.mock.calls
      .filter((call) => call[0] === 'deck_test_brain' && call[1] === 'agent.status')
      .map((call) => (call[2] as Record<string, unknown>).phase);
    expect(phasesBeforeReplacementActivity).toEqual(expect.arrayContaining(['detected', 'recovering']));
    expect(phasesBeforeReplacementActivity).not.toContain('recovered');

    mock.fireDelta('sess-1');
    await flushDispatch();
    mock.fireDelta('sess-1');
    await flushDispatch();

    const recoveredCalls = timelineEmitterEmitMock.mock.calls
      .filter((call) => call[0] === 'deck_test_brain'
        && call[1] === 'agent.status'
        && (call[2] as Record<string, unknown>).phase === 'recovered');
    expect(recoveredCalls).toHaveLength(1);
    expect((recoveredCalls[0]?.[2] as Record<string, unknown>).correlationId).toBe('corr-1');
  });

  it('allows sdk_turn_lost replay after assistant output only', async () => {
    expect(runtime.send('lost after text delta', 'msg-delta')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireDelta('sess-1');

    mock.fireError('sess-1', sdkTurnLostError());
    await waitForProviderSendCount(mock.provider, 2);

    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    expect(runtime.getStatus()).toBe('thinking');
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'lost after text delta',
      activityGeneration: { scope: 'session', sessionName: 'deck_test_brain', generation: 2 },
    }));
  });

  it('settles sdk_turn_lost after provider side effects without replaying or entering hard error', async () => {
    expect(runtime.send('unsafe lost turn', 'msg-unsafe')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    expect(runtime.send('queued after unsafe', 'msg-after-unsafe')).toBe('queued');
    mock.fireTool('sess-1', { id: 'tool-1', name: 'Bash', status: 'running' });

    mock.fireError('sess-1', sdkTurnLostError());
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after unsafe',
    }));
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.activeDispatchEntries.map((entry) => entry.clientMessageId)).toEqual(['msg-after-unsafe']);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    const recoveryStatusCalls = timelineEmitterEmitMock.mock.calls
      .filter((call) => call[0] === 'deck_test_brain' && call[1] === 'agent.status')
      .map((call) => call[2] as Record<string, unknown>)
      .filter((payload) => payload.status === SDK_TURN_LOST_RECOVERY_STATUS);
    expect(recoveryStatusCalls).toEqual([]);
    expect(timelineEmitterEmitMock.mock.calls.some((call) => call[1] === 'session.state' && (call[2] as { state?: string }).state === 'error')).toBe(false);
  });

  it.each([
    ['ambiguous heartbeat evidence', sdkTurnLostError({ replayDecision: 'unsafe_ambiguous' })],
  ])('denies unsafe sdk_turn_lost replay after %s', async (_name, error) => {
    expect(runtime.send('unsafe lost turn', 'msg-unsafe')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);

    mock.fireError('sess-1', error);
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toBe('error');
    expect(runtime.pendingEntries).toEqual([]);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toMatchObject({
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      recoverable: false,
    });
    expect(readSdkTurnLostRecoveryMetadata(error)).not.toBeNull();
  });

  it('denies sdk_turn_lost replay for terminal local truth and exhausted isolated budget', async () => {
    expect(runtime.send('terminal truth lost turn', 'msg-terminal')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    (runtime as unknown as { _currentActivityGenerationLocallyCancelled: boolean })._currentActivityGenerationLocallyCancelled = true;
    mock.fireError('sess-1', sdkTurnLostError());
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toBe('error');
    expect(runtime.getDiagnosticSnapshot().lastProviderError?.message).toMatch(/ended before completion/i);

    const freshProvider = makeMockProvider();
    const fresh = new TransportSessionRuntime(freshProvider.provider, 'deck_test_brain');
    await fresh.initialize(defaultConfig);
    fresh.send('budget exhausted lost turn', 'msg-budget');
    await waitForProviderSendCount(freshProvider.provider, 1);
    (fresh as unknown as { _sdkTurnLostRecoveryAttempts: Map<string, number> })
      ._sdkTurnLostRecoveryAttempts
      .set('deck_test_brain:session:deck_test_brain:1:sdk_turn_lost', 2);

    freshProvider.fireError('sess-1', sdkTurnLostError());
    await flushDispatch();

    expect(freshProvider.provider.send).toHaveBeenCalledTimes(1);
    expect(fresh.getStatus()).toBe('error');
    expect(fresh.getDiagnosticSnapshot().lastProviderError?.message).toMatch(/ended before completion/i);
  });

  it('treats stopped-generation provider_tool_item evidence as non-blocking but keeps ordinary stale and unattributed snapshots blocking', async () => {
    const generation = { scope: 'session' as const, sessionName: 'deck_test_brain', generation: 1 };
    expect(isProviderSnapshotNonBlockingForStoppedGeneration({
      status: 'current',
      activeWorkCount: 1,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item'],
      activityGeneration: generation,
    }, generation)).toBe(true);
    expect(isProviderSnapshotNonBlockingForStoppedGeneration({
      status: 'stale',
      activeWorkCount: 1,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item'],
      activityGeneration: generation,
    }, generation)).toBe(false);
    expect(isProviderSnapshotNonBlockingForStoppedGeneration({
      status: 'current',
      activeWorkCount: 1,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item'],
      providerDiagnosticGeneration: 'turn-only',
    }, generation)).toBe(false);

    expect(runtime.send('stoppable active turn', 'msg-stop-active')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 1,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item'],
      activityGeneration: generation,
      updatedAt: Date.now(),
    }));
    expect(runtime.send('queued after stop', 'msg-stop-queued')).toBe('queued');

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after stop',
    }));
    expect(runtime.pendingCount).toBe(0);

    mock.fireComplete('sess-1');
    await flushDispatch();
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.getDiagnosticSnapshot().busyReasons).not.toContain('provider_tool_item');
  });

  it('external completion settles idle even when Codex still reports provider_tool_item for the stopped generation', async () => {
    const generation = { scope: 'session' as const, sessionName: 'deck_test_brain', generation: 1 };
    expect(runtime.send('marker-backed turn with orphan provider tool', 'msg-orphan-tool')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 1,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item'],
      activityGeneration: generation,
      updatedAt: Date.now(),
    }));

    expect(runtime.settleActiveDispatchFromExternalCompletion('marker-complete-but-provider-tool-stale')).toBe(true);

    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.getDiagnosticSnapshot().busyReasons).not.toContain('provider_tool_item');
  });

  it('stop clears no-active-turn orphan provider_tool_item evidence instead of leaving the session tool_running', async () => {
    const generation = { scope: 'session' as const, sessionName: 'deck_test_brain', generation: 1 };
    expect(runtime.send('turn whose local dispatch already settled externally', 'msg-orphan-stop')).toBe('sent');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 1,
      activeToolCount: 1,
      busyReasons: ['provider_tool_item'],
      activityGeneration: generation,
      updatedAt: Date.now(),
    }));
    Object.assign(runtime as unknown as {
      _activeTurn: null;
      _sending: boolean;
      _activeDispatchEntries: unknown[];
      _activeDispatchId: null;
      _activeDispatchProviderStarted: boolean;
      _activeDispatchCancelled: boolean;
    }, {
      _activeTurn: null,
      _sending: false,
      _activeDispatchEntries: [],
      _activeDispatchId: null,
      _activeDispatchProviderStarted: false,
      _activeDispatchCancelled: false,
    });

    await runtime.cancel();

    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.getDiagnosticSnapshot().busyReasons).not.toContain('provider_tool_item');
  });

  it('send() merges description and runtime prompt into normalized systemText', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({ ...defaultConfig, description: 'expert', systemPrompt: 'runtime only' });
    r.send('help');
    await flushDispatch();
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'help',
      assembledMessage: 'help',
      systemText: expect.stringContaining('expert\n\nruntime only'),
    }));
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      systemText: expect.stringContaining('Use memory MCP search'),
    }));
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      systemText: expect.stringContaining('do not invent details from summaries alone'),
    }));
  });

  it('send() uses the resolved context namespace from session config instead of hardcoded sessionKey namespace', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({
      ...defaultConfig,
      cwd: '/tmp/project',
      contextNamespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      contextNamespaceDiagnostics: ['namespace:explicit'],
    });

    r.send('help');
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
        },
      }),
      diagnostics: expect.arrayContaining(['namespace:explicit']),
    }));
  });

  it('send() uses bootstrap-provided local processed freshness for personal continuity authority', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'x');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'github.com/acme/repo',
      },
      contextLocalProcessedFreshness: 'fresh',
    });

    r.send('help');
    await flushDispatch();
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        authoritySource: 'processed_local',
        freshness: 'fresh',
      }),
      diagnostics: expect.arrayContaining(['authority:processed_local']),
    }));
  });

  it('shared-scope sends fail before provider dispatch when no authoritative shared context exists', async () => {
    const r = new TransportSessionRuntime(mock.provider, 'x');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
    });

    r.send('help');
    await flushDispatch();

    // Authority not ready → recoverable "retry scheduled". The send is blocked
    // before provider dispatch, but the turn is NOT dropped: it is re-queued and
    // the session shows in-progress while an auto-retry waits for authority to
    // refresh. (Genuinely unrecoverable shared-context failures —
    // unsupported / authority-unavailable — still surface as a terminal error.)
    expect(mock.provider.send).not.toHaveBeenCalled();
    expect(r.getStatus()).toBe('thinking');
    expect(r.pendingCount).toBe(1);
    expect(r.getDiagnosticSnapshot().lastProviderError).toMatchObject({
      code: 'SHARED_CONTEXT_RETRY_SCHEDULED',
      recoverable: true,
    });
  });


  it('surfaces refreshed context bootstrap metadata through onSessionInfoChange for live inspection', async () => {
    const infoUpdates: Array<Record<string, unknown>> = [];
    const r = new TransportSessionRuntime(mock.provider, 'x');
    r.onSessionInfoChange = (info) => { infoUpdates.push(info as Record<string, unknown>); };
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'launch-snapshot',
      },
      contextNamespaceDiagnostics: ['namespace:launch'],
      contextLocalProcessedFreshness: 'stale',
    });
    r.setContextBootstrapResolver(async () => ({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
      diagnostics: ['namespace:server-control-plane'],
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: { allowDegraded: false, allowLocalFallback: true },
    }));

    r.send('refresh bootstrap metadata please');
    await flushDispatch();

    expect(infoUpdates.at(0)).toMatchObject({
      contextNamespace: { scope: 'personal', projectId: 'launch-snapshot' },
      contextNamespaceDiagnostics: ['namespace:launch'],
      contextLocalProcessedFreshness: 'stale',
      contextRetryExhausted: false,
    });
    expect(infoUpdates.at(-1)).toMatchObject({
      contextNamespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
      contextNamespaceDiagnostics: ['namespace:server-control-plane'],
      contextRemoteProcessedFreshness: 'fresh',
      contextLocalProcessedFreshness: 'fresh',
      contextRetryExhausted: true,
      contextSharedPolicyOverride: { allowDegraded: false, allowLocalFallback: true },
    });
  });

  it('forwards approval requests through runtime callbacks', async () => {
    const approvalMock = makeMockProvider();
    const runtimeWithApproval = new TransportSessionRuntime(approvalMock.provider, 'deck_test_brain');
    const approvalEvents: Array<Record<string, unknown>> = [];
    runtimeWithApproval.onApprovalRequest = (request) => approvalEvents.push(request as Record<string, unknown>);
    await runtimeWithApproval.initialize(defaultConfig);

    approvalMock.fireApproval('sess-1', {
      id: 'approval-1',
      description: 'Allow file write',
      tool: 'shell',
      provider: 'qoder-sdk',
      providerGeneration: 7,
      providerToolUseId: 'tool-approval',
      inputPreview: '{"command":"pwd"}',
    });

    expect(approvalEvents).toEqual([
      {
        id: 'approval-1',
        description: 'Allow file write',
        tool: 'shell',
        provider: 'qoder-sdk',
        providerGeneration: 7,
        providerToolUseId: 'tool-approval',
        inputPreview: '{"command":"pwd"}',
      },
    ]);
  });

  it('forwards approval responses to the provider', async () => {
    const approvalMock = makeMockProvider();
    const runtimeWithApproval = new TransportSessionRuntime(approvalMock.provider, 'deck_test_brain');
    await runtimeWithApproval.initialize(defaultConfig);

    await runtimeWithApproval.respondApproval('approval-2', true);

    expect((approvalMock.provider as any).respondApproval).toHaveBeenCalledWith('sess-1', 'approval-2', true);
  });

  it('refreshes shared-context bootstrap on each dispatch turn instead of freezing launch-time namespace state', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'x');
    const refreshBootstrap = vi.fn()
      .mockResolvedValueOnce({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
        },
        diagnostics: ['namespace:server-control-plane'],
        remoteProcessedFreshness: 'fresh',
      })
      .mockResolvedValueOnce({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
        },
        diagnostics: ['namespace:server-personal-fallback'],
        localProcessedFreshness: 'fresh',
      });
    await r.initialize({
      ...defaultConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'launch-snapshot',
      },
      contextNamespaceDiagnostics: ['namespace:launch'],
    });
    r.setContextBootstrapResolver(refreshBootstrap);

    r.send('first');
    await flushDispatch();
    await flushDispatch();
    expect(localMock.provider.send).toHaveBeenNthCalledWith(1, 'sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
        },
        authoritySource: 'processed_remote',
      }),
      diagnostics: expect.arrayContaining(['namespace:server-control-plane']),
    }));

    localMock.fireComplete('sess-1');
    r.send('second');
    await flushDispatch();
    await flushDispatch();
    expect(localMock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      authority: expect.objectContaining({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
        },
        authoritySource: 'processed_local',
      }),
      diagnostics: expect.arrayContaining(['namespace:server-personal-fallback']),
    }));
    expect(refreshBootstrap).toHaveBeenCalledTimes(2);
  });

  it('skips startup memory injection when startupMemoryAlreadyInjected is true (session.restart / restore)', async () => {
    // Regression: restarting an existing session (or daemon restart that
    // restores persisted sessions) must NOT replay "related past work" into
    // the provider context. The conversation already has that preamble; a
    // second injection would pollute history with duplicate context.
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Should not be re-injected on restart',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Should not be re-injected on restart',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    // Simulate the restore path where the prior run already injected startup
    // memory and we persisted startupMemoryInjected=true to SessionRecord.
    await r.initialize({ ...defaultConfig, startupMemoryAlreadyInjected: true });

    // No memory.context timeline card — the UI must not re-show the startup
    // banner for a resumed conversation.
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({ reason: 'startup' }),
      expect.any(Object),
    );

    timelineEmitterEmitMock.mockClear();
    r.send('Follow-up message after restart');
    await flushDispatch();

    // The provider payload on the first post-restart turn must NOT contain
    // any `startupMemory` field — the runtime keeps `_startupMemory = null`.
    expect(localMock.provider.send).toHaveBeenCalledTimes(1);
    const call = localMock.provider.send.mock.calls[0];
    expect(call[1]).not.toHaveProperty('startupMemory');
  });

  it('fires onStartupMemoryInjected exactly once when startup memory first reaches the provider', async () => {
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Persist that we injected startup memory',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Persist that we injected startup memory',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    const onInjected = vi.fn();
    r.onStartupMemoryInjected = onInjected;

    await r.initialize(defaultConfig);
    await flushDispatch();

    // Callback fires only after the first turn that actually carried it.
    expect(onInjected).not.toHaveBeenCalled();

    r.send('first turn');
    await flushDispatch();
    expect(onInjected).toHaveBeenCalledTimes(1);

    // Subsequent turns don't refire the callback.
    r.send('second turn');
    await flushDispatch();
    expect(onInjected).toHaveBeenCalledTimes(1);
  });

  it('carries startup memory into the first transport payload', async () => {
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Remember to keep transport recall parity visible',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Remember to keep transport recall parity visible',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    await r.initialize(defaultConfig);
    await flushDispatch();

    // The "Historical context · injected" card MUST NOT fire at initialize
    // time — that would leak a fresh card on every restart-before-first-
    // message. The card is bound to the same commit boundary as the
    // persisted `startupMemoryInjected` flag; see the send assertion below.
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
    }), expect.any(Object));

    const preferencePreamble = `${PREFERENCE_CONTEXT_START}
User-authored preferences for this and future turns.
- Use pnpm for project commands
${PREFERENCE_CONTEXT_END}`;
    r.send('Need a transport recall test', 'startup-pref-turn', undefined, preferencePreamble);
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      startupMemory: expect.objectContaining({
        reason: 'startup',
        injectedText: expect.stringContaining('transport recall parity visible'),
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectionSurface: 'normalized-payload',
      }),
      messagePreamble: expect.stringContaining('transport recall parity visible'),
      assembledMessage: expect.stringContaining('transport recall parity visible'),
    }));
    const firstPayload = localMock.provider.send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(String(firstPayload.messagePreamble)).toContain('Use pnpm for project commands');
    const sentPayload = localMock.provider.send.mock.calls[0]?.[1] as { systemText?: string } | undefined;
    expect(sentPayload?.systemText ?? '').not.toContain('transport recall parity visible');
    // Exactly ONE startup card — fired when the provider payload actually
    // carried the preamble, same boundary as the persisted flag.
    const startupCardsAfterSend = timelineEmitterEmitMock.mock.calls.filter(
      (call) => call[1] === 'memory.context' && (call[2] as Record<string, unknown>)?.reason === 'startup',
    );
    expect(startupCardsAfterSend).toHaveLength(1);
    expect(startupCardsAfterSend[0][2]).toEqual(expect.objectContaining({
      reason: 'startup',
      injectedText: expect.stringContaining('transport recall parity visible'),
      preferenceItems: [
        { id: 'preference-1', text: 'Use pnpm for project commands' },
      ],
    }));

    timelineEmitterEmitMock.mockClear();
    r.send('second turn');
    await flushDispatch();
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
    }), expect.any(Object));
  });

  it('carries personal local startup memory when remote context is authoritative but has no startup hits', async () => {
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Local personal startup memory should still be visible',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Local personal startup memory should still be visible',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:server-personal-fallback', 'remote-processed:fresh'],
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory,
    }));

    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('first remote-authoritative personal turn');
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      startupMemory: expect.objectContaining({
        reason: 'startup',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectedText: expect.stringContaining('Local personal startup memory'),
      }),
      messagePreamble: expect.stringContaining('Local personal startup memory'),
      diagnostics: expect.arrayContaining(['memory:start:local-auxiliary']),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'startup',
        injectedText: expect.stringContaining('Local personal startup memory'),
      }),
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
  });

  it('does not stack duplicate startup cards across restart-before-first-message cycles', async () => {
    // Regression for the timeline showing multiple "Historical context ·
    // injected" cards on a session that had been restarted repeatedly
    // before the first user turn ever landed. Each initialize used to emit
    // one card, but `startupMemoryInjected` only persists AFTER the first
    // successful dispatch — so the flag never caught up and cards stacked.
    const startupItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Do not emit card until provider accepts preamble',
    });
    const startupMemory = {
      reason: 'startup' as const,
      runtimeFamily: 'transport' as const,
      authoritySource: 'processed_local' as const,
      sourceKind: 'local_processed' as const,
      injectionSurface: 'message-preamble' as const,
      injectedText: '# Recent project memory\n\n- Do not emit card until provider accepts preamble',
      items: [startupItem],
    };
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
      startupMemory,
    }));

    // Simulate three restarts before the first real message — flag never
    // persists, so `alreadyInjected` stays false across all three.
    await r.initialize(defaultConfig);
    await r.initialize(defaultConfig);
    await r.initialize(defaultConfig);
    await flushDispatch();
    expect(timelineEmitterEmitMock).not.toHaveBeenCalledWith('deck_test_brain', 'memory.context', expect.objectContaining({
      reason: 'startup',
    }), expect.any(Object));

    // First real turn — now exactly one card fires.
    r.send('first real turn after restarts');
    await flushDispatch();
    const startupCards = timelineEmitterEmitMock.mock.calls.filter(
      (call) => call[1] === 'memory.context' && (call[2] as Record<string, unknown>)?.reason === 'startup',
    );
    expect(startupCards).toHaveLength(1);
  });

  it('send() adds transport recall to the payload and emits linked memory.context evidence', async () => {
    const memoryItem = makeSearchItem({
      projectId: 'repo-1',
      summary: 'Fixed transport recall latency by emitting explicit memory.context cards',
      relevanceScore: 0.92,
    });
    searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult([memoryItem]));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall runtime', 'client-turn-1');
    await flushDispatch();
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('Please recall recent transport memory'),
      namespace: { scope: 'personal', projectId: 'repo-1' },
      repo: 'repo-1',
      currentEnterpriseId: undefined,
      limit: 10,
    }));
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      memoryRecall: expect.objectContaining({
        reason: 'message',
        runtimeFamily: 'transport',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
        injectionSurface: 'normalized-payload',
        query: expect.stringContaining('Please recall recent transport memory'),
      }),
      messagePreamble: expect.stringContaining('[Related past work]'),
      assembledMessage: expect.stringContaining('[Related past work]'),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-1',
        runtimeFamily: 'transport',
        authoritySource: 'processed_local',
        sourceKind: 'local_processed',
      }),
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );
  });

  it('still injects per-message local recall when authority resolves to processed_remote for shared scope', async () => {
    const memoryItem = makeSearchItem({
      projectId: 'repo-1',
      scope: 'project_shared',
      enterpriseId: 'ent-1',
      workspaceId: 'ws-1',
      summary: 'Should not be injected while remote authority is active',
      relevanceScore: 0.92,
    });
    searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult([memoryItem]));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      diagnostics: ['namespace:server-control-plane'],
      remoteProcessedFreshness: 'fresh',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall runtime', 'client-turn-remote');
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringContaining('Please recall recent transport memory'),
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1', workspaceId: 'ws-1' },
      currentEnterpriseId: 'ent-1',
      repo: 'repo-1',
      limit: 10,
    }));
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      memoryRecall: expect.objectContaining({
        reason: 'message',
        authoritySource: 'processed_remote',
        sourceKind: 'local_processed',
      }),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-remote',
        authoritySource: 'processed_remote',
        sourceKind: 'local_processed',
      }),
      expect.anything(),
    );
  });

  it('applies the configured recall threshold for transport message recall', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      memoryRecallMinScore: 0.4,
    });
    const memoryItem = makeSearchItem({
      summary: 'Mid-threshold multilingual semantic match',
      relevanceScore: 0.4446,
    });
    searchLocalMemorySemanticMock.mockResolvedValue(makeSearchResult([memoryItem]));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);

    r.send('我感觉现在发的消息都没有相关历史recall了, 就像这句话 你自己测试下 不可能没有!', 'client-turn-threshold');
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      memoryRecall: expect.objectContaining({
        reason: 'message',
        query: expect.stringContaining('我感觉现在发的消息都没有相关历史recall了'),
      }),
    }));
  });

  it('emits explicit skipped-recall statuses for control and short transport messages', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('/status', 'client-turn-control');
    await flushDispatch();
    localMock.fireComplete('sess-1');
    r.send('hi', 'client-turn-short');
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(localMock.provider.send).toHaveBeenNthCalledWith(1, 'sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(localMock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-control',
        status: 'skipped_control_message',
        items: [],
      }),
      expect.anything(),
    );
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-short',
        status: 'skipped_short_prompt',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('transport memory recall fails open when lookup fails', async () => {
    searchLocalMemorySemanticMock.mockRejectedValue(new Error('lookup failed'));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall runtime', 'client-turn-2');
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-2',
        status: 'failed',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('bounds live context bootstrap so a hung resolver cannot block transport dispatch', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '50');
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });
    r.setContextBootstrapResolver(() => new Promise(() => {}));
    timelineEmitterEmitMock.mockClear();

    r.send('/status', 'client-bootstrap-hang');
    await sleep(80);
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: '/status',
      authority: expect.objectContaining({
        namespace: { scope: 'personal', projectId: 'repo-1' },
      }),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'transport-user:client-bootstrap-hang',
        status: 'skipped_control_message',
      }),
      expect.anything(),
    );
  });

  it('bounds semantic memory recall so a hung embedding/search path still sends the turn', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '50');
    searchLocalMemorySemanticMock.mockReturnValue(new Promise(() => {}));
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });
    timelineEmitterEmitMock.mockClear();

    r.send('Please recall recent transport memory around recall timeout handling', 'client-recall-hang');
    await sleep(80);
    await flushDispatch();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalled();
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'transport-user:client-recall-hang',
        status: 'failed',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('clears sending and marks the runtime errored when provider send-start never settles', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_PROVIDER_SEND_TIMEOUT_MS', '50');
    const localMock = makeMockProvider();
    (localMock.provider.send as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    await r.initialize({
      ...defaultConfig,
      contextNamespace: { scope: 'personal', projectId: 'repo-1' },
      contextLocalProcessedFreshness: 'fresh',
    });

    r.send('/status', 'client-provider-hang');
    await sleep(80);
    await flushDispatch();

    expect(localMock.provider.send).toHaveBeenCalledTimes(1);
    expect(r.getStatus()).toBe('error');
    expect(r.sending).toBe(false);
    expect(r.activeDispatchEntries).toEqual([]);
  });

  it('emits a template-prompt skip status before transport recall lookup', async () => {
    const localMock = makeMockProvider();
    const r = new TransportSessionRuntime(localMock.provider, 'deck_test_brain');
    r.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'repo-1' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await r.initialize(defaultConfig);
    timelineEmitterEmitMock.mockClear();

    // Use a real template-prompt marker (workflow phrase). Bare
    // @openspec/changes/... references by themselves are now allowed —
    // they're common in user debugging prompts and must still trigger recall.
    r.send('Drive the implementation of @openspec/changes/shared-agent-context aggressively.', 'client-turn-template');
    await waitForProviderSendCount(localMock.provider, 1);

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(localMock.provider.send).toHaveBeenCalledWith('sess-1', expect.not.objectContaining({
      memoryRecall: expect.anything(),
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'memory.context',
      expect.objectContaining({
        reason: 'message',
        relatedToEventId: 'transport-user:client-turn-template',
        status: 'skipped_template_prompt',
        items: [],
      }),
      expect.anything(),
    );
  });

  it('onComplete sets status to idle and appends to history', () => {
    runtime.send('go');
    mock.fireComplete('sess-1');

    expect(runtime.getStatus()).toBe('idle');
    const h = runtime.getHistory();
    expect(h).toHaveLength(2);
    expect(h[0].role).toBe('user');
    expect(h[1].role).toBe('assistant');
  });

  it('onError sets status to error', () => {
    runtime.send('go');
    mock.fireError('sess-1');
    expect(runtime.getStatus()).toBe('error');
    expect(runtime.sending).toBe(false);
  });

  it('cancel() delegates to provider.cancel and locally drains queued messages if no provider callback arrives', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued1', 'msg-q1');
    runtime.send('queued2', 'msg-q2');
    expect(runtime.pendingCount).toBe(2);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-q1', text: 'queued1' },
      { clientMessageId: 'msg-q2', text: 'queued2' },
    ]);

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued1\n\nqueued2',
      assembledMessage: 'queued1\n\nqueued2',
    }));
    expect(runtime.pendingCount).toBe(0);
  });

  it('cancel() drains queued messages immediately even when provider.cancel never settles', async () => {
    (mock.provider.cancel as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(() => {}));
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued while stop is pending', 'msg-q-pending-stop');
    expect(runtime.pendingCount).toBe(1);

    const cancelPromise = runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    await cancelPromise;
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(runtime.pendingCount).toBe(0);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued while stop is pending',
      assembledMessage: 'queued while stop is pending',
    }));

    mock.fireComplete('sess-1', { content: 'queued completed' });
    await flushDispatch();

    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.getHistory().some((message) => message.content === 'queued completed')).toBe(true);
  });

  it('cancel() drains queued messages when a zero-work stale provider snapshot lags behind the stopped generation', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued after stale stop', 'msg-q-stale-stop');
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 0 },
      updatedAt: Date.now(),
    }));

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.getDiagnosticSnapshot().busyReasons).toContain('runtime_dispatch');
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after stale stop',
      assembledMessage: 'queued after stale stop',
    }));
  });

  it('cancel() drains queued messages when provider explicitly reports a zero-work stale snapshot after Stop', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued after explicit stale stop', 'msg-q-explicit-stale-stop');
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'stale',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: ['snapshot_stale'],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 0 },
      updatedAt: Date.now() - 60_000,
    }));

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    expect(runtime.pendingCount).toBe(0);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after explicit stale stop',
      assembledMessage: 'queued after explicit stale stop',
    }));
  });

  it('repeated cancel() calls still drain later queued messages when old zero-work snapshots arrive across generations', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('second after first stop', 'msg-second-after-stop');
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 0 },
      updatedAt: Date.now(),
    }));

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'second after first stop',
      assembledMessage: 'second after first stop',
    }));

    runtime.send('third after second stop', 'msg-third-after-stop');
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 1 },
      updatedAt: Date.now(),
    }));

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 3);

    expect(runtime.pendingCount).toBe(0);
    expect(mock.provider.cancel).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(3, 'sess-1', expect.objectContaining({
      userMessage: 'third after second stop',
      assembledMessage: 'third after second stop',
    }));
  });

  it('ignores the late CANCELLED callback from the stopped dispatch after queued work drains', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued after stop', 'msg-q-after-stop');

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);
    const sendCountAfterDrain = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;

    mock.fireError('sess-1', { code: 'CANCELLED', message: 'late stop callback', recoverable: true });
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledTimes(sendCountAfterDrain);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    expect(runtime.pendingCount).toBe(0);
  });

  it('does not let a locally stopped turn stale provider snapshot block queued work', async () => {
    let providerActive = false;
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: providerActive ? 1 : 0,
      activeToolCount: 0,
      busyReasons: providerActive ? ['provider_wait'] : [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 1 },
      updatedAt: Date.now(),
    }));

    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    providerActive = true;
    runtime.send('queued after stop', 'msg-q-after-provider-cancel');
    expect(runtime.pendingCount).toBe(1);

    providerActive = false;
    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    expect(runtime.pendingCount).toBe(0);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after stop',
      assembledMessage: 'queued after stop',
    }));

    mock.fireError('sess-1', { code: PROVIDER_ERROR_CODES.CANCELLED, message: 'late stop callback', recoverable: true });
    await flushDispatch();

    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    expect(runtime.pendingCount).toBe(0);
    expect(mock.provider.send).toHaveBeenCalledTimes(2);
  });

  it('does not let a locally stopped turn stale provider snapshot block a later send', async () => {
    let snapshotGeneration = 1;
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: snapshotGeneration },
      updatedAt: Date.now(),
    }));

    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);

    snapshotGeneration = 0;
    await runtime.cancel();

    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.getDiagnosticSnapshot().busyReasons).not.toContain('snapshot_stale');

    runtime.send('later after stop', 'msg-later-after-stop');
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'later after stop',
      assembledMessage: 'later after stop',
    }));
  });

  it('does not let a late provider CANCELLED callback from a stopped turn drain behind an already-active next turn', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued after stop', 'msg-q-after-stop');

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    runtime.send('queued behind active next turn', 'msg-q-behind-next');
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.sending).toBe(true);

    mock.fireError('sess-1', { code: PROVIDER_ERROR_CODES.CANCELLED, message: 'late stop callback', recoverable: true });
    await flushDispatch();

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-q-behind-next', text: 'queued behind active next turn' },
    ]);
    expect(runtime.sending).toBe(true);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
  });

  it('cancel() with no queued messages settles to idle immediately, before the provider CANCELLED callback', async () => {
    runtime.send('only');
    await flushDispatch();
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.getStatus()).not.toBe('idle'); // turn is live

    runtime.cancel();
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    // No queued work → reflect idle now, without waiting for the provider's
    // (possibly late/absent) CANCELLED callback. Otherwise getStatus() stays
    // streaming/thinking and resolveTransportSessionListState() reports
    // 'running' on the next session_list pass — resurrecting the "working" UI
    // animation after the user stopped.
    expect(runtime.getStatus()).toBe('idle');
  });

  it('cancel() with no queued messages is not resurrected by a zero-work stale provider snapshot', async () => {
    runtime.send('only');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 0 },
      updatedAt: Date.now(),
    }));

    await runtime.cancel();

    const snapshot = runtime.getDiagnosticSnapshot();
    expect(runtime.getStatus()).toBe('idle');
    expect(snapshot.blockingWorkCount).toBe(0);
    expect(snapshot.busyReasons).not.toContain('snapshot_stale');
  });

  it('cancel() with no queued messages is not resurrected by an explicit zero-work stale provider snapshot', async () => {
    runtime.send('only');
    await waitForProviderSendCount(mock.provider, 1);
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'stale',
      activeWorkCount: 0,
      activeToolCount: 0,
      busyReasons: ['snapshot_stale'],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 0 },
      updatedAt: Date.now() - 60_000,
    }));

    await runtime.cancel();

    const snapshot = runtime.getDiagnosticSnapshot();
    expect(runtime.getStatus()).toBe('idle');
    expect(snapshot.blockingWorkCount).toBe(0);
    expect(snapshot.busyReasons).not.toContain('snapshot_stale');
  });

  it('cancel() stops a turn before provider.send starts when context bootstrap is still running', async () => {
    const resolveBootstraps: Array<() => void> = [];
    runtime.setContextBootstrapResolver(() => new Promise((resolve) => {
      resolveBootstraps.push(() => resolve({
        namespace: { scope: 'personal', projectId: 'test' },
        diagnostics: [],
      }));
    }));

    runtime.send('first');
    runtime.send('queued after cancel', 'msg-q1');
    runtime.cancel();
    resolveBootstraps[0]?.();
    await flushDispatch();
    await waitForBootstrapResolverCount(resolveBootstraps, 2);
    resolveBootstraps[1]?.();
    await waitForProviderSendCount(mock.provider, 1);

    expect(mock.provider.cancel).not.toHaveBeenCalled();
    expect(mock.provider.send).toHaveBeenCalledTimes(1);
    expect(mock.provider.send).not.toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'first',
    }));
    expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      userMessage: 'queued after cancel',
      assembledMessage: 'queued after cancel',
    }));
    expect(runtime.pendingEntries).toEqual([]);
  });

  it('can edit and remove queued messages by clientMessageId', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued1', 'msg-q1');
    runtime.send('queued2', 'msg-q2');

    expect(runtime.editPendingMessage('msg-q1', 'edited queued1')).toBe(true);
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-q1', text: 'edited queued1' },
      { clientMessageId: 'msg-q2', text: 'queued2' },
    ]);

    expect(runtime.removePendingMessage('msg-q2')).toEqual({
      clientMessageId: 'msg-q2',
      text: 'queued2',
    });
    expect(runtime.pendingEntries).toEqual([
      { clientMessageId: 'msg-q1', text: 'edited queued1' },
    ]);
  });

  it('drains the edited queued text into the next turn', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued1', 'msg-q1');

    expect(runtime.editPendingMessage('msg-q1', 'edited queued1')).toBe(true);

    mock.fireComplete('sess-1');
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'edited queued1',
      assembledMessage: 'edited queued1',
    }));
    expect(runtime.pendingEntries).toEqual([]);
  });

  it('cancelled turns drain pending messages into the next turn', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued1', 'msg-q1');
    runtime.send('queued2', 'msg-q2');

    runtime.cancel();
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued1\n\nqueued2',
      assembledMessage: 'queued1\n\nqueued2',
    }));
    expect(runtime.pendingCount).toBe(0);
  });

  it('cancel() closes open tools before draining queued messages when provider cancel is silent', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireTool('sess-1', {
      id: 'tool-queued-cancel',
      name: 'Agent',
      status: 'running',
    });
    runtime.send('queued after stop', 'msg-q-stop');
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.getDiagnosticSnapshot().busyReasons).toContain('open_tool_call');

    await runtime.cancel();
    await waitForProviderSendCount(mock.provider, 2);

    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-queued-cancel',
        tool: 'Agent',
        terminalStatus: 'cancelled',
        terminalReason: 'user_cancelled',
      }),
      expect.objectContaining({
        source: 'daemon',
        confidence: 'high',
      }),
    );
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    expect(runtime.getDiagnosticSnapshot().busyReasons).not.toContain('open_tool_call');
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after stop',
      assembledMessage: 'queued after stop',
    }));
  });

  it('external completion settles the active turn and drains queued messages without waiting for provider callbacks', async () => {
    runtime.send('first marker-backed workflow turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireTool('sess-1', {
      id: 'tool-marker',
      name: 'Bash',
      status: 'running',
    });
    runtime.send('queued continuation after marker', 'cmd-next');
    expect(runtime.pendingCount).toBe(1);

    expect(runtime.settleActiveDispatchFromExternalCompletion('test-marker-completed')).toBe(true);
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued continuation after marker',
      assembledMessage: 'queued continuation after marker',
    }));
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-marker',
        tool: 'Bash',
        terminalStatus: 'stale',
        terminalReason: 'provider_stale',
      }),
      expect.objectContaining({
        source: 'daemon',
        confidence: 'high',
      }),
    );

    mock.fireError('sess-1', { code: 'CANCELLED', message: 'late cancellation from settled turn', recoverable: true });
    expect(runtime.sending).toBe(true);
    expect(runtime.getStatus()).not.toBe('idle');
  });

  it('external completion cancels provider-only active snapshots before draining queued messages', async () => {
    let providerActive = false;
    (mock.provider as TransportProvider).getActiveWorkSnapshot = vi.fn(() => ({
      status: 'current',
      activeWorkCount: providerActive ? 1 : 0,
      activeToolCount: 0,
      busyReasons: providerActive ? ['provider_compaction'] : [],
      generation: { scope: 'session', sessionName: 'deck_test_brain', generation: 1 },
      updatedAt: Date.now(),
    }));
    (mock.provider.cancel as ReturnType<typeof vi.fn>).mockImplementation(() => {
      providerActive = false;
      return Promise.resolve();
    });

    runtime.send('first turn with provider-only active work', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    providerActive = true;
    // Reproduce the production log shape: the runtime has stale active work, but
    // `_activeDispatchProviderStarted` is already false while the provider
    // snapshot still reports provider-only activity such as Codex compaction.
    (runtime as unknown as { _activeDispatchProviderStarted: boolean })._activeDispatchProviderStarted = false;
    runtime.send('queued after stuck compact', 'cmd-next');

    expect(runtime.settleActiveDispatchFromExternalCompletion('health-poll-stale-active-turn')).toBe(true);
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after stuck compact',
      assembledMessage: 'queued after stuck compact',
    }));
    expect(runtime.pendingCount).toBe(0);
  });

  it('recoverable provider errors drain pending messages into the next turn', async () => {
    runtime.send('first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued after empty response', 'msg-q1');

    mock.fireError('sess-1', {
      code: 'PROVIDER_ERROR',
      message: 'Qwen exited without producing a response',
      recoverable: true,
    });
    await waitForProviderSendCount(mock.provider, 2);

    expect(mock.provider.send).toHaveBeenCalledTimes(2);
    expect(mock.provider.send).toHaveBeenNthCalledWith(2, 'sess-1', expect.objectContaining({
      userMessage: 'queued after empty response',
      assembledMessage: 'queued after empty response',
    }));
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
  });

  it('CANCELLED error → idle (not error)', () => {
    runtime.send('go');
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled', recoverable: true });
    expect(runtime.getStatus()).toBe('idle');
  });

  it('events from wrong session are ignored', () => {
    runtime.send('go');
    mock.fireDelta('other-session');
    mock.fireComplete('other-session');
    expect(runtime.getStatus()).toBe('thinking');
    expect(runtime.getHistory()).toHaveLength(1); // only user msg
  });

  it('kill() clears everything', async () => {
    runtime.send('go');
    runtime.send('queued', 'msg-kill');
    await runtime.kill();

    expect(runtime.providerSessionId).toBeNull();
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.pendingEntries).toEqual([]);
    expect(runtime.activeDispatchEntries).toEqual([]);
  });

  it('getHistory() returns a copy', () => {
    runtime.send('test');
    mock.fireComplete('sess-1');
    const h = runtime.getHistory();
    h.push({} as AgentMessage);
    expect(runtime.getHistory()).toHaveLength(2);
  });

  it('sending flag tracks turn', () => {
    expect(runtime.sending).toBe(false);
    runtime.send('go');
    expect(runtime.sending).toBe(true);
    mock.fireComplete('sess-1');
    expect(runtime.sending).toBe(false);
  });

  // ── N1 + G1 regression suite (audit f395d49c-78c) ─────────────────────────
  //
  // T5 — `_drainPending` MUST set `_sending=true` BEFORE invoking `_onDrain`.
  //      Pre-fix the order was splice → onDrain (with _sending still false) →
  //      _dispatchTurn (sets _sending=true). Any synchronous re-entrant
  //      `runtime.send` from an onDrain listener would have seen _sending=false
  //      and started a parallel dispatch, racing the merged turn. Node's
  //      EventEmitter doesn't currently yield, so the race wasn't triggerable,
  //      but the contract is now hardened for future refactors.
  //
  // T6 — `runtime.onDrain` MUST receive the full PendingTransportMessage[]
  //      array (one entry per original user message) so that the
  //      session-manager-registered callback in `wireTransportCallbacks` can
  //      emit one `user.message` timeline event per entry. Three audit rounds
  //      misread this contract before confirming it; the test locks it down
  //      so future refactors cannot silently merge entries before timeline
  //      emission and reintroduce the G1 "merged turn drops user messages"
  //      bug 3 candidate.

  it('T5 (N1 contract): _drainPending sets `_sending=true` before invoking the onDrain callback', async () => {
    // Establish active turn so subsequent sends queue.
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued-a', 'cmd-a');
    runtime.send('queued-b', 'cmd-b');
    expect(runtime.pendingCount).toBe(2);

    // Register onDrain to capture `runtime.sending` at the moment the
    // callback fires. Pre-fix this would be `false` (race window).
    let sendingDuringDrain: boolean | null = null;
    runtime.onDrain = (messages) => {
      sendingDuringDrain = runtime.sending;
      // sanity — drain payload still matches the contract used by T6 below
      expect(messages).toHaveLength(2);
    };

    // Complete the active turn — onComplete → _drainPending → onDrain.
    mock.fireComplete('sess-1');

    expect(sendingDuringDrain).toBe(true);
  });

  it('T6 (G1 contract): onDrain receives per-entry PendingTransportMessage[] with original clientMessageIds intact', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued-a SECRET_BODY_SHOULD_NOT_LEAK', 'cmd-a', [
      { id: 'att-a', daemonPath: '/tmp/private-secret.txt', originalName: 'private-secret.txt' },
    ]);
    runtime.send('queued-b', 'cmd-b', undefined, undefined, { sharedActor: sharedActorFixture });
    runtime.send('queued-c', 'cmd-c');
    expect(runtime.pendingCount).toBe(3);

    let received: { messages: PendingTransportMessage[]; merged: string; count: number; metadata: unknown } | null = null;
    runtime.onDrain = (messages, merged, count, metadata) => {
      // Snapshot so test assertions can run after fireComplete returns.
      received = { messages: messages.map((entry) => ({ ...entry })), merged, count, metadata };
    };

    mock.fireComplete('sess-1');

    expect(received).not.toBeNull();
    const captured = received!;
    expect(captured.count).toBe(3);
    expect(captured.messages.map((entry) => entry.clientMessageId)).toEqual(['cmd-a', 'cmd-b', 'cmd-c']);
    expect(captured.messages.map((entry) => entry.text)).toEqual(['queued-a SECRET_BODY_SHOULD_NOT_LEAK', 'queued-b', 'queued-c']);
    // The merged string also matches the join used by _drainPending.
    expect(captured.merged).toBe('queued-a SECRET_BODY_SHOULD_NOT_LEAK\n\nqueued-b\n\nqueued-c');
    expect(captured.metadata).toMatchObject({
      pendingVersion: expect.any(Number),
      entries: [
        { clientMessageId: 'cmd-a', ordinal: 0, attachmentIds: ['att-a'] },
        { clientMessageId: 'cmd-b', ordinal: 1, actorSessionName: 'deck_test_brain', sharedActionId: 'action-shared' },
        { clientMessageId: 'cmd-c', ordinal: 2 },
      ],
    });
    const safeMetadata = JSON.stringify(captured.metadata);
    expect(safeMetadata).not.toContain('SECRET_BODY_SHOULD_NOT_LEAK');
    expect(safeMetadata).not.toContain('/tmp/private-secret.txt');
    expect(safeMetadata).not.toContain('private-secret.txt');
  });

  it('preserves shared actor metadata on queued entries and drain callbacks without injecting it into provider text', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('shared queued', 'cmd-shared', undefined, undefined, { sharedActor: sharedActorFixture });
    expect(runtime.pendingEntries).toEqual([
      expect.objectContaining({
        clientMessageId: 'cmd-shared',
        text: 'shared queued',
        sharedActor: sharedActorFixture,
      }),
    ]);

    let received: PendingTransportMessage[] = [];
    runtime.onDrain = (messages) => {
      received = messages.map((entry) => ({ ...entry }));
    };

    mock.fireComplete('sess-1');
    await waitForProviderSendCount(mock.provider, 2);

    expect(received).toEqual([
      expect.objectContaining({
        clientMessageId: 'cmd-shared',
        text: 'shared queued',
        sharedActor: sharedActorFixture,
      }),
    ]);
    const resentPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(resentPayload.userMessage).toBe('shared queued');
    expect(resentPayload).not.toHaveProperty('sharedActor');
    expect(String(resentPayload.assembledMessage)).not.toContain('Shared User');
  });

  it('T5b (N1 contract): synchronous re-entrant runtime.send from onDrain listener queues into pending, never starts a parallel turn', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued', 'cmd-queued');

    const earlierProviderSendCalls = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    let reentrantResult: 'sent' | 'queued' | null = null;
    runtime.onDrain = () => {
      // A listener that synchronously re-enters runtime.send must NOT start
      // a parallel dispatch — `_sending` is already true (T5 contract).
      reentrantResult = runtime.send('re-entrant', 'cmd-reentrant');
    };

    mock.fireComplete('sess-1');
    await waitForProviderSendCount(mock.provider, earlierProviderSendCalls + 1);

    expect(reentrantResult).toBe('queued');
    // The re-entrant entry now sits in _pendingMessages, separate from the
    // merged drain turn that fired.
    expect(runtime.pendingEntries.map((entry) => entry.clientMessageId)).toContain('cmd-reentrant');
    // provider.send called once more (the merged drain turn), NOT twice.
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(earlierProviderSendCalls + 1);
  });

  it('drains defensively instead of entering idle when pending messages remain without an active turn', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued-after-invariant-break', 'cmd-queued');
    expect(runtime.pendingCount).toBe(1);

    const internal = runtime as unknown as {
      _sending: boolean;
      _activeTurn: unknown;
      setStatus: (status: 'idle') => void;
    };
    internal._sending = false;
    internal._activeTurn = null;

    const before = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    internal.setStatus('idle');
    await waitForProviderSendCount(mock.provider, before + 1);

    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
    const resentPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(resentPayload.userMessage).toBe('queued-after-invariant-break');
  });

  it('drainPendingIfIdle sends queued messages when an idle runtime still has pending work', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued-after-idle', 'cmd-queued-idle');
    expect(runtime.pendingCount).toBe(1);

    const internal = runtime as unknown as {
      _status: 'idle';
      _sending: boolean;
      _activeTurn: unknown;
    };
    internal._status = 'idle';
    internal._sending = false;
    internal._activeTurn = null;

    const before = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(runtime.drainPendingIfIdle('test-idle-pending')).toBe(true);
    await waitForProviderSendCount(mock.provider, before + 1);

    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
    const resentPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(resentPayload.userMessage).toBe('queued-after-idle');
  });

  it('cancels a stale active turn once so queued messages drain without waiting for the cancel callback', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued-after-stale-active', 'cmd-queued-stale');
    expect(runtime.pendingCount).toBe(1);

    const internal = runtime as unknown as {
      _lastActivityAt: number;
      _lastProviderOutputAt: number;
    };
    internal._lastActivityAt = 1_000;
    internal._lastProviderOutputAt = 1_000;

    expect(runtime.cancelStaleActiveTurnWithPending({
      reason: 'test-stale-active',
      nowMs: 11_001,
      staleMs: 10_000,
    })).toBe(true);
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');
    await waitForProviderSendCount(mock.provider, 2);
    expect(runtime.getDiagnosticSnapshot(11_001).stalePendingRecoveryActive).toBe(false);

    expect(runtime.cancelStaleActiveTurnWithPending({
      reason: 'test-stale-active-duplicate',
      nowMs: 20_000,
      staleMs: 10_000,
    })).toBe(false);
    expect(mock.provider.cancel).toHaveBeenCalledTimes(1);

    const beforeLateCancelSendCount = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    mock.fireError('sess-1', { code: 'CANCELLED', message: 'cancelled stale turn', recoverable: true });
    await flushDispatch();

    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    expect(runtime.getDiagnosticSnapshot(20_000).stalePendingRecoveryActive).toBe(false);
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(beforeLateCancelSendCount);
    const resentPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(resentPayload.userMessage).toBe('queued-after-stale-active');
  });

  it('send() starts stale active-turn recovery when a new message queues behind silent work', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);

    const internal = runtime as unknown as {
      _lastActivityAt: number;
      _lastProviderOutputAt: number;
    };
    const staleAt = Date.now() - 301_000;
    internal._lastActivityAt = staleAt;
    internal._lastProviderOutputAt = staleAt;

    expect(runtime.send('queued-after-memory-compression-stall', 'cmd-after-stall')).toBe('queued');
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');

    await waitForProviderSendCount(mock.provider, 2);
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    expect(runtime.getDiagnosticSnapshot().stalePendingRecoveryActive).toBe(false);
    const resentPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(resentPayload.userMessage).toBe('queued-after-memory-compression-stall');
  });

  it('recoverSilentActiveTurn settles a phantom active turn with NO queued work to idle', async () => {
    // Regression: a provider that started a turn but went silent and never sent
    // a completion (Codex phantom) leaves the session "working" forever EVEN WITH
    // AN EMPTY QUEUE (just a stuck spinner). The with-pending recovery would not
    // fire here; recoverSilentActiveTurn must settle it to idle once stale.
    runtime.send('only-turn', 'cmd-only');
    await waitForProviderSendCount(mock.provider, 1);
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.getStatus()).not.toBe('idle');

    const internal = runtime as unknown as { _lastActivityAt: number };
    internal._lastActivityAt = 1_000;

    // Not yet stale → no-op. The caller-supplied 10s threshold is floored by
    // the production silent-turn floor so legitimate long Codex thinking does
    // not get force-settled by a short health-poll threshold.
    expect(runtime.recoverSilentActiveTurn({ nowMs: 5_000, staleMs: 10_000 })).toBe(false);
    expect(runtime.getStatus()).not.toBe('idle');
    expect(runtime.recoverSilentActiveTurn({ nowMs: 61_000, staleMs: 60_000 })).toBe(false);
    // Truly stale (provider silent past the last-resort no-tool threshold) +
    // empty queue → settle to idle. This covers memory-compression/finalize
    // misses where no queued prompt exists to trigger queue-visible recovery.
    expect(runtime.recoverSilentActiveTurn({ nowMs: 1_000 + 5 * 60_000 + 1, staleMs: 10_000 })).toBe(true);
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.sending).toBe(false);
    expect(runtime.activeDispatchEntries).toEqual([]);
    expect(runtime.pendingCount).toBe(0);
    // Idempotent — nothing left active to recover.
    expect(runtime.recoverSilentActiveTurn({ nowMs: 30_000, staleMs: 10_000 })).toBe(false);
  });

  it('recoverSilentActiveTurn protects a RUNNING tool at the short threshold, recovers only after a long silence', async () => {
    runtime.send('long codex command', 'cmd-long');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireTool('sess-1', {
      id: 'tool-silent',
      name: 'Bash',
      status: 'running',
    });
    runtime.send('queued after silent tool', 'cmd-queued-silent');
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.getDiagnosticSnapshot().busyReasons).toContain('open_tool_call');

    const internal = runtime as unknown as { _lastActivityAt: number };
    internal._lastActivityAt = 1_000;

    // FIX: a turn whose tool is still RUNNING must NOT be cancelled at the short
    // phantom threshold — a legitimate long tool (e.g. a 180s `tcpdump` wait) is
    // silent but real. Recovery is suppressed while the tool is open + recent.
    expect(runtime.recoverSilentActiveTurn({
      reason: 'health-poll-stale-active-turn',
      nowMs: 11_001,
      staleMs: 10_000,
    })).toBe(false);
    expect(runtime.sending).toBe(true);
    expect(runtime.getDiagnosticSnapshot().busyReasons).toContain('open_tool_call');

    // After silence well past the tool-aware floor (>15min), a genuinely orphaned
    // tool is terminalized and queued work drains.
    const longStaleMs = 16 * 60_000;
    const beforeDrainSendCount = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(runtime.recoverSilentActiveTurn({
      reason: 'health-poll-stale-active-turn',
      nowMs: 1_000 + longStaleMs + 1,
      staleMs: longStaleMs,
    })).toBe(true);
    await waitForProviderSendCount(mock.provider, beforeDrainSendCount + 1);

    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-silent',
        tool: 'Bash',
        terminalStatus: 'stale',
        terminalReason: 'provider_stale',
      }),
      expect.objectContaining({
        source: 'daemon',
        confidence: 'high',
      }),
    );
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    const resentPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(resentPayload.userMessage).toBe('queued after silent tool');
    expect(runtime.getDiagnosticSnapshot().busyReasons).not.toContain('open_tool_call');
  });

  it('recoverSilentActiveTurn does not force-settle a silent no-tool turn at the short threshold', async () => {
    runtime.send('no-tool turn', 'cmd-no-tool');
    await waitForProviderSendCount(mock.provider, 1);
    expect(runtime.getDiagnosticSnapshot().activeToolCount).toBe(0);
    const internal = runtime as unknown as { _lastActivityAt: number };
    internal._lastActivityAt = 1_000;
    // No tool open is still not proof of a phantom: Codex can legitimately
    // think/generate silently for more than 60s. The health-poll safety net is
    // last-resort only.
    expect(runtime.recoverSilentActiveTurn({ nowMs: 61_001, staleMs: 60_000 })).toBe(false);
    expect(runtime.getStatus()).not.toBe('idle');
  });

  it('locally abandons stale active work when provider cancel never settles', async () => {
    vi.stubEnv('IMCODES_TRANSPORT_STALE_PENDING_CANCEL_FALLBACK_MS', '50');
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireTool('sess-1', {
      id: 'tool-cancel-fallback',
      name: 'Bash',
      status: 'running',
    });
    runtime.send('queued-after-lost-cancel', 'cmd-queued-lost-cancel');
    expect(runtime.pendingCount).toBe(1);

    const internal = runtime as unknown as {
      _lastActivityAt: number;
      _lastProviderOutputAt: number;
    };
    internal._lastActivityAt = 1_000;
    internal._lastProviderOutputAt = 1_000;

    const beforeDrainSendCount = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(runtime.cancelStaleActiveTurnWithPending({
      reason: 'test-stale-active-lost-cancel',
      nowMs: 11_001,
      staleMs: 10_000,
    })).toBe(true);
    expect(mock.provider.cancel).toHaveBeenCalledWith('sess-1');

    await sleep(80);
    await waitForProviderSendCount(mock.provider, beforeDrainSendCount + 1);

    expect(runtime.pendingCount).toBe(0);
    expect(runtime.sending).toBe(true);
    expect(runtime.getDiagnosticSnapshot(11_200).stalePendingRecoveryActive).toBe(false);
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_test_brain',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-cancel-fallback',
        tool: 'Bash',
        terminalStatus: 'cancelled',
        terminalReason: 'user_cancelled',
      }),
      expect.objectContaining({
        source: 'daemon',
        confidence: 'high',
      }),
    );
    const resentPayload = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(resentPayload.userMessage).toBe('queued-after-lost-cancel');
  });

  it('ignores late provider deltas after a turn has already settled', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireDelta('sess-1');
    expect(runtime.getStatus()).toBe('streaming');
    mock.fireComplete('sess-1');
    await flushDispatch();
    expect(runtime.getStatus()).toBe('idle');

    mock.fireDelta('sess-1');

    expect(runtime.getStatus()).toBe('idle');
  });

  it('does NOT drop a provider completion that arrives with no active turn — records it and drains queued work', async () => {
    // Regression: the broad `!hasActiveTurnWork()` guard used to `return` here,
    // silently dropping the completion. Because provider callbacks are not
    // dispatch-id scoped, the active-turn flags can be cleared (out-of-band
    // settle / drain) while a real completion is still in flight and a message
    // is still queued — dropping it stalls the queue so the agent stops replying.
    runtime.send('first turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued follow-up', 'cmd-queued');
    expect(runtime.pendingCount).toBe(1);
    const sendCountBefore = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;
    const historyLenBefore = runtime.getHistory().length;

    // Simulate the desync: active-turn state cleared while a turn is still
    // resolving and a message remains queued.
    const internal = runtime as unknown as {
      _sending: boolean;
      _activeTurn: unknown;
      _activeDispatchEntries: unknown[];
    };
    internal._sending = false;
    internal._activeTurn = null;
    internal._activeDispatchEntries = [];

    // The real completion now arrives with no active turn. It MUST NOT be
    // dropped: the message is recorded to history AND the queued message drains.
    mock.fireComplete('sess-1', { id: 'msg-real', content: 'real reply' });
    await waitForProviderSendCount(mock.provider, sendCountBefore + 1);

    // The completion was recorded (not dropped). History also grows by the
    // drained user message, so assert presence rather than an exact count.
    expect(runtime.getHistory().some((m) => m.id === 'msg-real')).toBe(true);
    expect(runtime.getHistory().length).toBeGreaterThan(historyLenBefore);
    expect(runtime.pendingCount).toBe(0);
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCountBefore + 1);
    const drained = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(drained.userMessage).toBe('queued follow-up');
  });

  it('ignores a late provider error when no active turn or queued work remains', async () => {
    runtime.send('first turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    mock.fireComplete('sess-1');
    await flushDispatch();
    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.pendingCount).toBe(0);
    const sendCountBefore = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;

    mock.fireError('sess-1', { code: 'PROVIDER_ERROR', message: 'late stray error', recoverable: false });
    await flushDispatch();

    expect(runtime.getStatus()).toBe('idle');
    expect(runtime.pendingCount).toBe(0);
    expect(runtime.getDiagnosticSnapshot().lastProviderError).toBeUndefined();
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCountBefore);
  });

  it('drains queued work on recoverable provider error even when active-turn state was cleared', async () => {
    runtime.send('first turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued follow-up', 'cmd-queued');
    expect(runtime.pendingCount).toBe(1);
    const sendCountBefore = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;

    const internal = runtime as unknown as {
      _sending: boolean;
      _activeTurn: unknown;
      _activeDispatchEntries: unknown[];
    };
    internal._sending = false;
    internal._activeTurn = null;
    internal._activeDispatchEntries = [];

    mock.fireError('sess-1', { code: 'PROVIDER_ERROR', message: 'recoverable late error', recoverable: true });
    await waitForProviderSendCount(mock.provider, sendCountBefore + 1);

    expect(runtime.pendingCount).toBe(0);
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCountBefore + 1);
    const drained = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(drained.userMessage).toBe('queued follow-up');
  });

  it('preserves queued work on unrecoverable provider error when active-turn state was cleared', async () => {
    runtime.send('first turn', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued follow-up', 'cmd-queued');
    expect(runtime.pendingCount).toBe(1);
    const sendCountBefore = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length;

    const internal = runtime as unknown as {
      _sending: boolean;
      _activeTurn: unknown;
      _activeDispatchEntries: unknown[];
    };
    internal._sending = false;
    internal._activeTurn = null;
    internal._activeDispatchEntries = [];

    mock.fireError('sess-1', { code: 'PROVIDER_ERROR', message: 'fatal late error', recoverable: false });
    await flushDispatch();

    expect(runtime.getStatus()).toBe('error');
    expect(runtime.pendingCount).toBe(1);
    expect(runtime.pendingEntries.map((entry) => entry.clientMessageId)).toEqual(['cmd-queued']);
    expect((mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sendCountBefore);
  });

  it('does not cancel a recently active turn with queued work', async () => {
    runtime.send('first', 'cmd-first');
    await waitForProviderSendCount(mock.provider, 1);
    runtime.send('queued-while-live', 'cmd-queued-live');
    const lastActivityAt = runtime.lastActivityAt;

    expect(runtime.cancelStaleActiveTurnWithPending({
      reason: 'test-live-active',
      nowMs: lastActivityAt + 9_999,
      staleMs: 10_000,
    })).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();
    expect(runtime.pendingCount).toBe(1);
  });

  it('truncates user-authored description and systemPrompt to USER_SESSION_TEXT_MAX_CHARS', async () => {
    // Defense in depth: a user paste larger than the 300-char cap (from
    // shared/user-session-text-caps.ts) must not bloat every subsequent
    // turn's system prompt. Tests both `setDescription` / `setSystemPrompt`
    // (live edit) and `initialize()` (cold start).
    const oversized = 'X'.repeat(2000);
    runtime.setDescription(oversized);
    runtime.setSystemPrompt(oversized);
    runtime.send('hi after oversize set', 'cap-after-set');
    await waitForProviderSendCount(mock.provider, 1);
    const sentAfter = mock.provider.send.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const systemText = String(sentAfter.systemText ?? '');
    // The description+systemPrompt contributions both should be exactly 300
    // 'X's, not 2000. Since they're joined by `\n\n`, the total 'X' chars in
    // systemText should be 600.
    const xCount = (systemText.match(/X/g) ?? []).length;
    expect(xCount).toBe(600);
    expect(systemText).not.toMatch(/X{301}/);

    // Same enforcement when the values come from initialize() config.
    const freshProvider = makeMockProvider();
    const fresh = new TransportSessionRuntime(freshProvider.provider, 'deck_cap_brain');
    await fresh.initialize({ ...defaultConfig, description: oversized, systemPrompt: oversized });
    fresh.send('hi after init', 'cap-after-init');
    await waitForProviderSendCount(freshProvider.provider, 1);
    const sentInit = freshProvider.provider.send.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const initSystemText = String(sentInit.systemText ?? '');
    const initXCount = (initSystemText.match(/X/g) ?? []).length;
    expect(initXCount).toBe(600);
    expect(initSystemText).not.toMatch(/X{301}/);
  });

  it('injects IM.codes identity block intact alongside oversize user-authored text', async () => {
    // p2p audit 37bfbb85-430 N-A regression: before this fix, the
    // IM.codes identity prompt (~350 chars) was merged into `systemPrompt`
    // by session-manager and then silently truncated by
    // `clampUserSessionText(300)`. After the fix, identity is injected
    // at the assembly layer peer-level with `MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE`
    // and lives OUTSIDE the user-authored 300-char cap. It must survive
    // intact even when the user pastes 2000 chars into description AND
    // systemPrompt simultaneously.
    //
    // The Generated Image Reporting prompt used to ride alongside the
    // identity block at the assembly layer, but now lives in Codex SDK's
    // `appendImcodesBaseInstructions` — Codex-only, once per thread.
    // It must NOT appear in the per-turn payload here.
    const oversized = 'Y'.repeat(2000);
    const freshProvider = makeMockProvider();
    const fresh = new TransportSessionRuntime(freshProvider.provider, 'deck_identity_brain');
    await fresh.initialize({
      ...defaultConfig,
      sessionKey: 'deck_identity_brain',
      sessionName: 'deck_identity_brain',
      label: 'Identity Brain',
      description: oversized,
      systemPrompt: oversized,
    });
    fresh.send('hello identity', 'identity-1');
    await waitForProviderSendCount(freshProvider.provider, 1);
    const sent = freshProvider.provider.send.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const systemText = String(sent.systemText ?? '');

    // User-authored cap still enforced: total Y count is 2 * 300 = 600.
    const yCount = (systemText.match(/Y/g) ?? []).length;
    expect(yCount).toBe(600);
    expect(systemText).not.toMatch(/Y{301}/);

    // Identity block present in full, including the exact session name
    // and the display label. None of these strings exist in the user
    // text (Y's only), so any match must come from the daemon-injected
    // block — proving it survived the user cap.
    expect(systemText).toMatch(/IM\.codes session identity:/);
    expect(systemText).toMatch(/Exact session name: deck_identity_brain/);
    expect(systemText).toMatch(/Display label: Identity Brain/);
    expect(systemText).toMatch(/imcodes send/);
    expect(systemText).toMatch(/full absolute filesystem path/);
    expect(systemText).toMatch(/not a bare filename or relative path/);

    // Generated Image Reporting must NOT be in the per-turn assembly
    // payload — it now lives in Codex SDK baseInstructions tail.
    expect(systemText).not.toMatch(/Generated images:/);
    expect(systemText).not.toMatch(/Generated Image Reporting:/);
  });

  it('uses exact session name when no label is provided to setSessionIdentity', async () => {
    // When the user has not labeled the session, the daemon block must
    // still render a valid identity header — falling back to the exact
    // session name as the display label so the model never sees an empty
    // identity field.
    const freshProvider = makeMockProvider();
    const fresh = new TransportSessionRuntime(freshProvider.provider, 'deck_unlabeled_brain');
    await fresh.initialize({
      ...defaultConfig,
      sessionKey: 'deck_unlabeled_brain',
      sessionName: 'deck_unlabeled_brain',
    });
    fresh.send('hello', 'unlabeled-1');
    await flushDispatch();
    const sent = freshProvider.provider.send.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const systemText = String(sent.systemText ?? '');
    expect(systemText).toMatch(/Exact session name: deck_unlabeled_brain/);
    expect(systemText).toMatch(/Display label: deck_unlabeled_brain/);
  });

  // ── Alias quick-insert (A′) providerText split ────────────────────────────
  // Contract: `send(..., { providerText })` delivers `providerText` to the
  // provider (and runtime history) while the ORIGINAL `message` remains the
  // timeline copy (onDrain entry.text / pendingEntries.text). Must hold for the
  // direct-send path, the busy→queued→drain path, AND the SQLite-rehydrated path.
  describe('alias expansion (A′) — providerText routing', () => {
    const ORIGINAL = 'deploy ;;(prod-host) now';
    const EXPANDED =
      'The ;;(name) markers below expand to values.\n;;(prod-host): prod.example.com\n\ndeploy ;;(prod-host) now';

    it('direct send: provider + history get providerText; timeline copy stays the marker text', async () => {
      const onDrainEntries: PendingTransportMessage[][] = [];
      runtime.onDrain = (entries) => { onDrainEntries.push(entries); };
      expect(runtime.send(ORIGINAL, 'alias-direct-1', undefined, undefined, { providerText: EXPANDED })).toBe('sent');
      await flushDispatch();
      // Provider receives the expanded agent-bound copy.
      expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        userMessage: EXPANDED,
        assembledMessage: expect.stringContaining(EXPANDED),
      }));
      // The marker text must NEVER be what the provider ran.
      const sent = (mock.provider.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(String(sent.userMessage)).not.toBe(ORIGINAL);
      // Runtime history (replayed to the provider on later turns) carries the expanded copy.
      expect(runtime.getHistory().some((m) => m.role === 'user' && m.content === EXPANDED)).toBe(true);
      expect(runtime.getHistory().some((m) => m.role === 'user' && m.content === ORIGINAL)).toBe(false);
    });

    it('busy → queued → drain: onDrain timeline entry keeps the marker text, provider still gets the expanded text', async () => {
      runtime.send('first turn');
      await waitForProviderSendCount(mock.provider, 1);

      const onDrainEntries: PendingTransportMessage[][] = [];
      runtime.onDrain = (entries) => { onDrainEntries.push(entries); };
      expect(runtime.send(ORIGINAL, 'alias-queued-1', undefined, undefined, { providerText: EXPANDED })).toBe('queued');
      // RV-B: the PUBLIC queue projection (diagnostics / status / UI) keeps the
      // ORIGINAL marker text and must NOT expose the expanded `providerText`.
      expect(runtime.pendingEntries).toEqual([{ clientMessageId: 'alias-queued-1', text: ORIGINAL }]);
      expect(runtime.pendingEntries[0]).not.toHaveProperty('providerText');
      // The internal resend view still carries full material (preservation only).
      expect(runtime.pendingEntriesForResend).toEqual([
        { clientMessageId: 'alias-queued-1', text: ORIGINAL, providerText: EXPANDED },
      ]);

      // Free the active turn so the queued entry drains.
      mock.fireComplete('sess-1');
      await waitForProviderSendCount(mock.provider, 2);

      // The deferred timeline emit (onDrain) uses the ORIGINAL marker text …
      const drained = onDrainEntries.flat().find((e) => e.clientMessageId === 'alias-queued-1');
      expect(drained?.text).toBe(ORIGINAL);
      // … while the provider got the expanded agent-bound copy.
      expect(mock.provider.send).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
        userMessage: EXPANDED,
      }));
    });

    it('SQLite rehydrate after restart: providerText survives; provider gets expanded, timeline entry stays the marker', async () => {
      runtime.send('first turn');
      await waitForProviderSendCount(mock.provider, 1);
      expect(runtime.send(ORIGINAL, 'alias-rehydrate-1', undefined, undefined, { providerText: EXPANDED })).toBe('queued');

      // Simulate a daemon restart: fresh runtime, same session, SQLite authority intact.
      const restartMock = makeMockProvider();
      const restarted = new TransportSessionRuntime(restartMock.provider, 'deck_test_brain');
      await restarted.initialize(defaultConfig);
      const onDrainEntries: PendingTransportMessage[][] = [];
      restarted.onDrain = (entries) => { onDrainEntries.push(entries); };

      expect(restarted.rehydratePendingFromStore()).toBe(1);
      // RV-B: the rehydrated entry still delivers the expanded copy to the
      // provider (asserted below), but the PUBLIC projection hides `providerText`.
      expect(restarted.pendingEntries).toEqual([
        { clientMessageId: 'alias-rehydrate-1', text: ORIGINAL },
      ]);
      expect(restarted.pendingEntries[0]).not.toHaveProperty('providerText');
      // Full material survives internally for delivery / resend preservation.
      expect(restarted.pendingEntriesForResend).toEqual([
        { clientMessageId: 'alias-rehydrate-1', text: ORIGINAL, providerText: EXPANDED },
      ]);

      expect(restarted.drainPendingIfIdle('test')).toBe(true);
      await waitForProviderSendCount(restartMock.provider, 1);
      expect(restartMock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        userMessage: EXPANDED,
      }));
      const drained = onDrainEntries.flat().find((e) => e.clientMessageId === 'alias-rehydrate-1');
      expect(drained?.text).toBe(ORIGINAL);
    });

    it('no providerText (common no-alias path) is byte-identical: provider runs the message text itself', async () => {
      expect(runtime.send('plain message, no markers', 'noalias-1')).toBe('sent');
      await flushDispatch();
      expect(mock.provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        userMessage: 'plain message, no markers',
      }));
      // No stray providerText is attached to the queue entry projection.
      expect(runtime.getHistory().some((m) => m.role === 'user' && m.content === 'plain message, no markers')).toBe(true);
    });

    it('editing a queued entry drops any stale providerText (edited text is delivered verbatim)', async () => {
      runtime.send('first turn');
      await waitForProviderSendCount(mock.provider, 1);
      runtime.send(ORIGINAL, 'alias-edit-1', undefined, undefined, { providerText: EXPANDED });
      // Public projection hides providerText; internal resend view still has it.
      expect(runtime.pendingEntries[0]).toEqual({ clientMessageId: 'alias-edit-1', text: ORIGINAL });
      expect(runtime.pendingEntriesForResend[0]).toEqual({ clientMessageId: 'alias-edit-1', text: ORIGINAL, providerText: EXPANDED });

      expect(runtime.editPendingMessage('alias-edit-1', 'edited plain text')).toBe(true);
      // providerText cleared → the edited text is now both timeline and provider copy,
      // in the public projection AND the internal resend view (no stale secret).
      expect(runtime.pendingEntries[0]).toEqual({ clientMessageId: 'alias-edit-1', text: 'edited plain text' });
      expect(runtime.pendingEntriesForResend[0]).toEqual({ clientMessageId: 'alias-edit-1', text: 'edited plain text' });

      mock.fireComplete('sess-1');
      await waitForProviderSendCount(mock.provider, 2);
      expect(mock.provider.send).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
        userMessage: 'edited plain text',
      }));
    });
  });
});
