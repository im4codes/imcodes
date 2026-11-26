import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import {
  BACKGROUND_SUBAGENT_WAKE_MODES,
  PROVIDER_CANCEL_ORIGINS,
  PROVIDER_ERROR_CODES,
  type ProviderCapabilities,
  type SessionConfig,
  type TransportProvider,
  type ProviderStatusUpdate,
  type ToolCallEvent,
} from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
} from '../../shared/agent-delegation.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { DAEMON_USER_NOTICE_CODE } from '../../shared/daemon-user-notices.js';

const runtimeRef = vi.hoisted(() => ({ current: undefined as TransportSessionRuntime | undefined }));
const timelineEmitMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    readByTypesPreferred: vi.fn(),
    append: vi.fn(),
    cleanup: vi.fn(),
    truncateAll: vi.fn(),
    readPreferred: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: timelineEmitMock,
    forgetSession: vi.fn(),
  },
}));

vi.mock('../../src/context/summary-compressor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/context/summary-compressor.js')>()),
  getStaleSessionCompressionRun: () => null,
  resolveSessionCompressionWatchRuns: () => undefined,
}));

vi.mock('../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/agent/session-manager.js')>()),
  getTransportRuntime: () => runtimeRef.current,
}));

const { recoverAgyStalledSession, shouldRunGenericSilentActiveTurnRecovery } = await import('../../src/daemon/lifecycle.js');
const { CHAT_MESSAGE_ORIGINS, USER_MESSAGE_ORIGIN_FIELDS } = await import('../../shared/chat-message-origin.js');

const SESSION = 'deck_agy_watchdog_brain';

function makeAgyMockProvider() {
  const deltaCbs = new Set<(sid: string, d: MessageDelta) => void>();
  const completeCbs = new Set<(sid: string, m: AgentMessage) => void>();
  const errorCbs = new Set<(sid: string, e: { code: string; message: string; recoverable: boolean }) => void>();
  const statusCbs = new Set<(sid: string, s: ProviderStatusUpdate) => void>();
  const toolCbs = new Set<(sid: string, t: ToolCallEvent) => void>();

  const capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    nativeAgentAdmission: 'session_fence',
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
    backgroundSubagentWake: BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME,
  };

  let activeBackgroundCount = 0;
  let backgroundProgressAt: number | undefined;
  const provider: TransportProvider = {
    id: 'agy-sdk',
    connectionMode: 'local-sdk',
    sessionOwnership: 'provider',
    capabilities,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    createSession: vi.fn(async () => 'agy-sess-1'),
    endSession: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    notifyActiveDelegation: vi.fn(async () => AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED),
    getActiveWorkSnapshot: () => (
      activeBackgroundCount > 0
        ? {
            active: true,
            activeWorkCount: activeBackgroundCount,
            activeToolCount: 0,
            backgroundWorkCount: activeBackgroundCount,
            ...(backgroundProgressAt !== undefined ? { lastBackgroundProgressAt: backgroundProgressAt } : {}),
            busyReasons: ['provider_background_work'],
          }
        : null
    ),
    onDelta: (cb) => {
      deltaCbs.add(cb);
      return () => { deltaCbs.delete(cb); };
    },
    onComplete: (cb) => {
      completeCbs.add(cb);
      return () => { completeCbs.delete(cb); };
    },
    onError: (cb) => {
      errorCbs.add(cb);
      return () => { errorCbs.delete(cb); };
    },
    onStatus: (cb) => {
      statusCbs.add(cb);
      return () => { statusCbs.delete(cb); };
    },
    onToolCall: (cb) => {
      toolCbs.add(cb);
      return () => { toolCbs.delete(cb); };
    },
  };

  return {
    provider,
    fireDelta(sid = 'agy-sess-1') {
      for (const cb of deltaCbs) cb(sid, { messageId: 'm1', role: 'assistant', delta: 'ok' });
    },
    fireComplete(sid = 'agy-sess-1') {
      for (const cb of completeCbs) cb(sid, { id: 'm1', sessionId: sid, kind: 'text', role: 'assistant', content: 'done', timestamp: Date.now(), status: 'complete' });
    },
    fireStatus(sid: string, status: ProviderStatusUpdate) {
      for (const cb of statusCbs) cb(sid, status);
    },
    fireTool(sid: string, tool: ToolCallEvent) {
      for (const cb of toolCbs) cb(sid, tool);
    },
    setBackgroundWorkCount(count: number) {
      activeBackgroundCount = count;
    },
    setBackgroundProgressAt(at: number | undefined) {
      backgroundProgressAt = at;
    },
    fireError(sid = 'agy-sess-1') {
      for (const cb of errorCbs) cb(sid, { code: PROVIDER_ERROR_CODES.CANCELLED, message: 'cancelled', recoverable: true });
    },
  };
}

const flushDispatch = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitForSendCount = async (sendFn: TransportProvider['send'], expected: number) => {
  const fn = sendFn as ReturnType<typeof vi.fn>;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    await flushDispatch();
    if (fn.mock.calls.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(fn.mock.calls.length).toBeGreaterThanOrEqual(expected);
};

describe('agy stale active-turn watchdog', () => {
  let mock: ReturnType<typeof makeAgyMockProvider>;
  let runtime: TransportSessionRuntime;
  let config: SessionConfig;
  let uniqueCounter = 0;

  beforeEach(async () => {
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    timelineEmitMock.mockReset();
    uniqueCounter += 1;
    const sessionName = `${SESSION}_${uniqueCounter}`;
    config = { sessionKey: sessionName };
    mock = makeAgyMockProvider();
    runtime = new TransportSessionRuntime(mock.provider, sessionName);
    await runtime.initialize(config);
    runtimeRef.current = runtime;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    runtimeRef.current = undefined;
    await runtime.kill().catch(() => {});
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
  });

  it('auto-recovers a hung silent agy-sdk turn after 12 minutes with STALE_WATCHDOG and dispatches system continue once per generation', async () => {
    const t0 = 1_700_100_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    expect(runtime.send('initial prompt', 'cmd-init')).toBe('sent');
    await waitForSendCount(mock.provider.send, 1);
    await flushDispatch();

    // Tool completed cleanly, then upstream SSE stalled with zero output.
    mock.fireTool('agy-sess-1', { id: 'tool-1', name: 'Read', status: 'running' });
    mock.fireTool('agy-sess-1', { id: 'tool-1', name: 'Read', status: 'completed' });
    expect(runtime.getDiagnosticSnapshot(t0).activeToolCount).toBe(0);

    // Below 12m threshold (including old 3m and 6m thresholds, 7m, 11m, and 11m59.999s): does not recover.
    const initialGen = runtime.getDiagnosticSnapshot(t0).activityGeneration;
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 180_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 360_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 11 * 60_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 719_999)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    // At 12m threshold: recovers once via STALE_WATCHDOG and dispatches system `continue`.
    nowSpy.mockReturnValue(t0 + 720_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 720_000)).toBe(true);
    expect(mock.provider.cancel).toHaveBeenCalledWith('agy-sess-1', {
      origin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG,
    });
    await waitForSendCount(mock.provider.send, 2);
    expect(mock.provider.send).toHaveBeenLastCalledWith('agy-sess-1', expect.objectContaining({
      userMessage: 'continue',
    }));

    expect(timelineEmitMock).toHaveBeenCalledWith(
      config.sessionKey,
      'assistant.text',
      expect.objectContaining({
        noticeCode: DAEMON_USER_NOTICE_CODE.AGY_WATCHDOG_RECOVERED,
        noticeParams: { minutes: 12 },
        streaming: false,
        automation: true,
      }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(timelineEmitMock).toHaveBeenCalledWith(
      config.sessionKey,
      'user.message',
      expect.objectContaining({
        text: 'continue',
        [USER_MESSAGE_ORIGIN_FIELDS.ORIGIN]: CHAT_MESSAGE_ORIGINS.SYSTEM,
      }),
      expect.objectContaining({ source: 'daemon' }),
    );

    // Calling again on the newly dispatched turn at +5s does not re-trigger.
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 725_000)).toBe(false);

    // Bounded to once per activity generation even if the previously recovered generation remains active.
    const cancelSpy = vi.fn(async () => undefined);
    const sendSpy = vi.fn(() => 'queued' as const);
    runtimeRef.current = {
      getDiagnosticSnapshot: () => ({
        status: 'streaming',
        sending: true,
        pendingCount: 0,
        pendingVersion: 1,
        activeDispatchCount: 1,
        stalePendingRecoveryActive: false,
        providerSessionBound: true,
        lastActivityAt: t0,
        lastActivityAgeMs: 740_000,
        lastProviderOutputAt: t0,
        lastProviderOutputAgeMs: 740_000,
        providerOutputSilenceMs: 740_000,
        unacknowledgedActiveAppendCount: 0,
        oldestUnacknowledgedActiveAppendAt: null,
        activityGeneration: initialGen,
        blockingWorkCount: 0,
        backgroundWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      }),
      requeueUnacknowledgedActiveAppendsFront: () => [],
      send: sendSpy,
      cancel: cancelSpy,
    } as unknown as TransportSessionRuntime;
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 740_000)).toBe(false);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('recovers after 12m when unacknowledged active-turn steering prompts wait with zero output, replaying them in order without duplicate user bubbles', async () => {
    const t0 = 1_700_200_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    expect(runtime.send('start task', 'cmd-base')).toBe('sent');
    await waitForSendCount(mock.provider.send, 1);
    await flushDispatch();

    const tAppend = t0 + 20_000;
    nowSpy.mockReturnValue(tAppend);
    // Provider emitted output right before steering arrived so both silence and append age start at tAppend.
    mock.fireDelta('agy-sess-1');
    expect(runtime.send('steer prompt 1', 'steer-msg-1', undefined, undefined, {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      timelineCommitted: true,
    })).toBe('queued');
    expect(runtime.send('steer prompt 2', 'steer-msg-2', undefined, undefined, {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      timelineCommitted: true,
    })).toBe('queued');
    const waitDeadline = Date.now() + 2_000;
    while ((mock.provider.notifyActiveDelegation as ReturnType<typeof vi.fn>).mock.calls.length < 2 && Date.now() < waitDeadline) {
      await flushDispatch();
    }
    expect(mock.provider.notifyActiveDelegation).toHaveBeenCalledTimes(2);

    // Status pings do not reset output silence or ack the steering prompts.
    mock.fireStatus('agy-sess-1', { status: 'thinking', label: 'Thinking...' });

    // Below 12m threshold (including old 90s / 3m / 6m thresholds and 11m59.999s): does not recover.
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tAppend + 90_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tAppend + 360_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tAppend + 719_999)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    // At 12m after unacked steering prompt: triggers recovery & replays both in order.
    const drainedTimelineEntries: unknown[] = [];
    const drainedMetaIds: string[] = [];
    runtime.onDrain = (entries, _merged, _count, meta) => {
      drainedTimelineEntries.push(...entries);
      for (const item of meta.entries) drainedMetaIds.push(item.clientMessageId);
    };

    nowSpy.mockReturnValue(tAppend + 720_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tAppend + 720_000)).toBe(true);
    expect(mock.provider.cancel).toHaveBeenCalledWith('agy-sess-1', {
      origin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG,
    });
    await waitForSendCount(mock.provider.send, 2);
    expect(mock.provider.send).toHaveBeenLastCalledWith('agy-sess-1', expect.objectContaining({
      userMessage: 'steer prompt 1\n\nsteer prompt 2',
    }));
    expect(timelineEmitMock).toHaveBeenCalledWith(
      config.sessionKey,
      'assistant.text',
      expect.objectContaining({
        noticeCode: DAEMON_USER_NOTICE_CODE.AGY_WATCHDOG_RECOVERED,
        noticeParams: { minutes: 12 },
        streaming: false,
        automation: true,
      }),
      expect.objectContaining({ source: 'daemon' }),
    );
    expect(drainedTimelineEntries).toEqual([]);
    expect(drainedMetaIds).toEqual(['steer-msg-1', 'steer-msg-2']);

    // No `user.message` emitted on replay (not `'continue'` and no duplicate bubble for replayed steers).
    const userMessageCalls = timelineEmitMock.mock.calls.filter(
      ([session, type]) => session === config.sessionKey && type === 'user.message',
    );
    expect(userMessageCalls).toEqual([]);
  });

  it('respects IMCODES_AGY_STALE_ACTIVE_TURN_MS override and never cancels running tools, background work, or active output', async () => {
    const t0 = 1_700_300_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    expect(runtime.send('work with tool', 'cmd-tool')).toBe('sent');
    await waitForSendCount(mock.provider.send, 1);
    await flushDispatch();

    // Open tool call protects the turn even after 10 minutes of silence.
    mock.fireTool('agy-sess-1', { id: 'tool-open', name: 'Bash', status: 'running' });
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 10 * 60_000)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    // Tool finishes, then a background subagent task stays open -> still protected.
    mock.fireTool('agy-sess-1', { id: 'tool-open', name: 'Bash', status: 'completed' });
    mock.setBackgroundWorkCount(1);
    expect(runtime.getDiagnosticSnapshot(t0 + 10 * 60_000).backgroundWorkCount).toBe(1);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 10 * 60_000)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    // Background task completes; active delta output clears unacknowledged append and resets silence.
    mock.setBackgroundWorkCount(0);
    expect(runtime.send('steer while streaming', 'steer-stream', undefined, undefined, {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      timelineCommitted: true,
    })).toBe('queued');
    for (let attempt = 0; attempt < 50 && runtime.getDiagnosticSnapshot(t0).unacknowledgedActiveAppendCount !== 1; attempt++) {
      await flushDispatch();
    }
    expect(runtime.getDiagnosticSnapshot(t0).unacknowledgedActiveAppendCount).toBe(1);
    const tOutput = t0 + 40_000;
    nowSpy.mockReturnValue(tOutput);
    mock.fireDelta('agy-sess-1');
    expect(runtime.getDiagnosticSnapshot(tOutput).unacknowledgedActiveAppendCount).toBe(0);

    // Env override is set to 60s -> honors env override measured from last output tOutput.
    vi.stubEnv('IMCODES_AGY_STALE_ACTIVE_TURN_MS', '60000');
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tOutput + 59_000)).toBe(false);
    nowSpy.mockReturnValue(tOutput + 60_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tOutput + 60_000)).toBe(true);
  });

  it('does not apply agy watchdog to non-agy providers and leaves generic recovery behavior intact', async () => {
    const t0 = 1_700_400_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    expect(runtime.send('codex work', 'cmd-codex')).toBe('sent');
    await waitForSendCount(mock.provider.send, 1);

    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'codex-sdk' }, t0 + 10 * 60_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'claude-code-sdk' }, t0 + 10 * 60_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'kimi-sdk' }, t0 + 10 * 60_000)).toBe(false);
    expect(shouldRunGenericSilentActiveTurnRecovery({ agentType: 'codex-sdk', providerId: 'codex-sdk' }, false)).toBe(false);
    expect(shouldRunGenericSilentActiveTurnRecovery({ agentType: 'claude-code-sdk', providerId: 'claude-code-sdk' }, false)).toBe(true);
    expect(shouldRunGenericSilentActiveTurnRecovery({ agentType: 'agy-sdk', providerId: 'agy-sdk' }, true)).toBe(false);
  });

  it('protects running tools and phantom background work against unacknowledged steering timeout below 20m and enforces the 20m ceiling', async () => {
    const t0 = 1_700_500_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    // 1) Running tool protects unacknowledged steering at 90s, 12m, and 19m, then recovers cleanly at the 20m ceiling.
    expect(runtime.send('turn with phantom tool', 'cmd-phantom')).toBe('sent');
    await waitForSendCount(mock.provider.send, 1);
    await flushDispatch();
    mock.fireTool('agy-sess-1', { id: 'tool-phantom', name: 'Bash', status: 'running' });

    const tAppend = t0 + 10_000;
    nowSpy.mockReturnValue(tAppend);
    expect(runtime.send('steer past phantom tool', 'steer-phantom-1', undefined, undefined, {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      timelineCommitted: true,
    })).toBe('queued');
    for (let i = 0; i < 50 && runtime.getDiagnosticSnapshot(tAppend).unacknowledgedActiveAppendCount !== 1; i++) {
      await flushDispatch();
    }
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tAppend + 90_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tAppend + 12 * 60_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 19 * 60_000)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    nowSpy.mockReturnValue(t0 + 20 * 60_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 20 * 60_000)).toBe(true);
    expect(mock.provider.cancel).toHaveBeenCalledWith('agy-sess-1', {
      origin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG,
    });
    await waitForSendCount(mock.provider.send, 2);
    expect(mock.provider.send).toHaveBeenLastCalledWith('agy-sess-1', expect.objectContaining({
      userMessage: 'steer past phantom tool',
    }));

    // 1b) Phantom/leaked background work without live progress also protects unacknowledged steering below 20m, then recovers at 20m.
    const tBg = t0 + 20 * 60_000 + 5_000;
    nowSpy.mockReturnValue(tBg);
    mock.setBackgroundWorkCount(1);
    mock.setBackgroundProgressAt(undefined);
    expect(runtime.send('steer during background work', 'steer-bg-1', undefined, undefined, {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      timelineCommitted: true,
    })).toBe('queued');
    for (let i = 0; i < 50 && runtime.getDiagnosticSnapshot(tBg).unacknowledgedActiveAppendCount !== 1; i++) {
      await flushDispatch();
    }
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tBg + 12 * 60_000)).toBe(false);
    nowSpy.mockReturnValue(tBg + 20 * 60_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tBg + 20 * 60_000)).toBe(true);
    await waitForSendCount(mock.provider.send, 3);
    mock.setBackgroundWorkCount(0);

    // 2) Without unacked steering, open tool / phantom backgroundWorkCount still protect at 15m but recover at the 20m ceiling.
    const tCeiling = tBg + 20 * 60_000 + 5_000;
    nowSpy.mockReturnValue(tCeiling);
    mock.fireTool('agy-sess-1', { id: 'tool-hung', name: 'Bash', status: 'running' });
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tCeiling + 15 * 60_000)).toBe(false);
    nowSpy.mockReturnValue(tCeiling + 20 * 60_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tCeiling + 20 * 60_000)).toBe(true);

    // 3) Stale reactive thinking / orphan background work with activeDispatchCount=0 cancels before dispatching continue.
    const callOrder: string[] = [];
    const customCancel = vi.fn(async () => { callOrder.push('cancel'); });
    const customSend = vi.fn(() => { callOrder.push('send'); return 'sent' as const; });
    runtimeRef.current = {
      getDiagnosticSnapshot: () => ({
        status: 'thinking',
        sending: false,
        pendingCount: 0,
        pendingVersion: 9,
        activeDispatchCount: 0,
        stalePendingRecoveryActive: false,
        providerSessionBound: true,
        lastActivityAt: tCeiling,
        lastActivityAgeMs: 20 * 60_000,
        lastProviderOutputAt: tCeiling,
        lastProviderOutputAgeMs: 20 * 60_000,
        providerOutputSilenceMs: 20 * 60_000,
        unacknowledgedActiveAppendCount: 0,
        oldestUnacknowledgedActiveAppendAt: null,
        activityGeneration: 'reactive-orphan-gen',
        blockingWorkCount: 0,
        backgroundWorkCount: 1,
        activeToolCount: 0,
        busyReasons: ['provider_wait'],
      }),
      requeueUnacknowledgedActiveAppendsFront: () => [],
      send: customSend,
      cancel: customCancel,
    } as unknown as TransportSessionRuntime;

    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, tCeiling + 20 * 60_000)).toBe(true);
    expect(callOrder).toEqual(['cancel', 'send']);
    expect(customCancel).toHaveBeenCalledWith({ origin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG });
  });

  it('never cancels an active background task reporting live progress past 20m-35m, and still recovers once progress freezes for 20m', async () => {
    const t0 = 1_700_550_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

    expect(runtime.send('run long vitest suite', 'cmd-long-vitest')).toBe('sent');
    await waitForSendCount(mock.provider.send, 1);
    await flushDispatch();

    // Background command stays alive while log keeps progressing even though providerSilenceMs is 25m and 35m,
    // and even with an unacked active steering append waiting 22m.
    mock.setBackgroundWorkCount(1);
    mock.setBackgroundProgressAt(t0);
    expect(runtime.send('steer during live suite', 'steer-live-bg', undefined, undefined, {
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
      timelineCommitted: true,
    })).toBe('queued');
    for (let i = 0; i < 50 && runtime.getDiagnosticSnapshot(t0).unacknowledgedActiveAppendCount !== 1; i++) {
      await flushDispatch();
    }

    const t25 = t0 + 25 * 60_000;
    nowSpy.mockReturnValue(t25);
    mock.setBackgroundProgressAt(t25 - 10_000);
    expect(runtime.getDiagnosticSnapshot(t25).lastBackgroundProgressAt).toBe(t25 - 10_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t25)).toBe(false);

    const t35 = t0 + 35 * 60_000;
    nowSpy.mockReturnValue(t35);
    mock.setBackgroundProgressAt(t35 - 5_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t35)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    // Once background log progress freezes at (t35 - 5s), it stays protected below 20m and recovers at +20m.
    const frozenAt = t35 - 5_000;
    nowSpy.mockReturnValue(frozenAt + 19 * 60_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, frozenAt + 19 * 60_000)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    nowSpy.mockReturnValue(frozenAt + 20 * 60_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, frozenAt + 20 * 60_000)).toBe(true);
    expect(mock.provider.cancel).toHaveBeenCalledWith('agy-sess-1', {
      origin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG,
    });
  });

  it('supports larger IMCODES_AGY_STALE_ACTIVE_TURN_MS overrides such as 30 minutes', async () => {
    const t0 = 1_700_580_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    vi.stubEnv('IMCODES_AGY_STALE_ACTIVE_TURN_MS', String(30 * 60_000));

    expect(runtime.send('high context long thinking', 'cmd-30m')).toBe('sent');
    await waitForSendCount(mock.provider.send, 1);
    await flushDispatch();

    // At 12m, 20m, and 29m: must NOT recover when configured to 30m.
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 12 * 60_000)).toBe(false);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 29 * 60_000)).toBe(false);
    expect(mock.provider.cancel).not.toHaveBeenCalled();

    nowSpy.mockReturnValue(t0 + 30 * 60_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 30 * 60_000)).toBe(true);
    expect(mock.provider.cancel).toHaveBeenCalledWith('agy-sess-1', {
      origin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG,
    });
  });

  it('does not permanently blacklist an activity generation when recovery send or cancel fails; retries after cooldown up to cap', async () => {
    const t0 = 1_700_600_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    let sendResult: 'queued' | 'dropped' = 'dropped';
    let cancelImpl = vi.fn(async () => undefined);
    const sendSpy = vi.fn(() => sendResult);
    const gen = 'retry-gen-p1-2';

    runtimeRef.current = {
      getDiagnosticSnapshot: () => ({
        status: 'streaming',
        sending: true,
        pendingCount: 0,
        pendingVersion: 1,
        activeDispatchCount: 1,
        stalePendingRecoveryActive: false,
        providerSessionBound: true,
        lastActivityAt: t0,
        lastActivityAgeMs: 720_000,
        lastProviderOutputAt: t0,
        lastProviderOutputAgeMs: 720_000,
        providerOutputSilenceMs: 720_000,
        unacknowledgedActiveAppendCount: 0,
        oldestUnacknowledgedActiveAppendAt: null,
        activityGeneration: gen,
        blockingWorkCount: 0,
        backgroundWorkCount: 0,
        activeToolCount: 0,
        busyReasons: [],
      }),
      requeueUnacknowledgedActiveAppendsFront: () => [],
      send: sendSpy,
      cancel: cancelImpl,
    } as unknown as TransportSessionRuntime;

    // Attempt 1 fails because send returns dropped -> returns false without completing generation.
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 720_000)).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Cooldown prevents immediate retry stampede before 60s.
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 750_000)).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Attempt 2 after cooldown: send succeeds, cancel throws -> still eligible for final retry after cooldown.
    sendResult = 'queued';
    cancelImpl = vi.fn(async () => { throw new Error('transient disconnect'); });
    (runtimeRef.current as unknown as { cancel: typeof cancelImpl }).cancel = cancelImpl;
    nowSpy.mockReturnValue(t0 + 780_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 780_000)).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(cancelImpl).toHaveBeenCalledTimes(1);

    // Attempt 3 after cooldown succeeds -> marks generation complete and deduplicates thereafter.
    const okCancel = vi.fn(async () => undefined);
    (runtimeRef.current as unknown as { cancel: typeof okCancel }).cancel = okCancel;
    nowSpy.mockReturnValue(t0 + 840_000);
    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 840_000)).toBe(true);
    expect(okCancel).toHaveBeenCalledWith({ origin: PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG });

    expect(await recoverAgyStalledSession({ name: config.sessionKey, agentType: 'agy-sdk' }, t0 + 900_000)).toBe(false);
    expect(sendSpy).toHaveBeenCalledTimes(3);
  });
});
