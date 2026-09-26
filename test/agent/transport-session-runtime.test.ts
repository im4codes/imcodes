import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderError, ProviderStatusUpdate, ProviderUsageUpdate, ToolCallEvent, TransportProvider } from '../../src/agent/transport-provider.js';
import { TRANSPORT_AUTO_COMPACT_CONTEXT_RATIO, TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { MemorySearchResult } from '../../src/context/memory-search.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import { CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE } from '../../shared/cron-types.js';
import { TASK_PAIR_BRAIN_CONTRACT_ID } from '../../shared/task-pair.js';

const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());
const searchLocalMemorySemanticMock = vi.hoisted(() => vi.fn());
const collectRecentSummarySyncCandidatesMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitterEmitMock },
}));

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemory: vi.fn(),
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

vi.mock('../../src/context/summary-sync.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/context/summary-sync.js')>();
  return {
    ...original,
    collectRecentSummarySyncCandidates: collectRecentSummarySyncCandidatesMock,
  };
});

function makeProvider(): TransportProvider {
  return {
    id: 'test-transport',
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
    send: vi.fn(),
    cancel: vi.fn(),
    createSession: vi.fn().mockResolvedValue('provider-session-1'),
    endSession: vi.fn(),
    onDelta: (_callback: (sessionId: string, delta: MessageDelta) => void) => () => undefined,
    onComplete: (_callback: (sessionId: string, message: AgentMessage) => void) => () => undefined,
    onError: (_callback: (sessionId: string, error: ProviderError) => void) => () => undefined,
    onApprovalRequest: (_callback) => undefined,
    onStatus: (_callback: (sessionId: string, status: ProviderStatusUpdate) => void) => () => undefined,
    onUsage: (_callback: (sessionId: string, update: ProviderUsageUpdate) => void) => () => undefined,
    onToolCall: (_callback: (sessionId: string, toolCall: ToolCallEvent) => void) => () => undefined,
    respondApproval: vi.fn().mockResolvedValue(undefined),
  } as TransportProvider;
}

async function waitForProviderSend(provider: TransportProvider): Promise<void> {
  const send = provider.send as ReturnType<typeof vi.fn>;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (send.mock.calls.length > 0) return;
  }
  expect(send).toHaveBeenCalled();
}

describe('TransportSessionRuntime memory provenance', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    resetAllSummarySyncHistories();
    timelineEmitterEmitMock.mockReset();
    searchLocalMemorySemanticMock.mockReset();
    collectRecentSummarySyncCandidatesMock.mockReset();
    collectRecentSummarySyncCandidatesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
  });

  describe('automatic compaction', () => {
    // Off by default (ratio above 1); these cases exercise it re-enabled at 0.75.
    beforeEach(() => { vi.stubEnv('IMCODES_TRANSPORT_AUTO_COMPACT_RATIO', '0.75'); });
    afterEach(() => { vi.unstubAllEnvs(); });

    const turnDone = (id: string, used: number, window = 258_400): AgentMessage => ({
      id,
      sessionId: 'provider-session-1',
      kind: 'text',
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
      status: 'complete',
      metadata: { usage: { input_tokens: 2_000, cache_read_input_tokens: used - 2_000, output_tokens: 30, model_context_window: window } },
    });
    const sentTexts = (provider: TransportProvider): string[] => (provider.send as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => JSON.stringify(call[1]));

    async function setup(reasserts: boolean | undefined) {
      let complete: ((sessionId: string, message: AgentMessage) => void) | undefined;
      const provider = makeProvider();
      provider.capabilities.compact = {
        execution: 'sdk-rpc',
        verified: true,
        completion: 'provider-event',
        cancellation: 'local-cancel',
        ...(reasserts === undefined ? {} : { reassertsSessionSystemText: reasserts }),
      };
      provider.refreshSessionSystemText = vi.fn();
      provider.onComplete = (callback) => {
        complete = callback;
        return () => undefined;
      };
      provider.onStatus = (callback) => {
        (provider as unknown as { __status?: typeof callback }).__status = callback;
        return () => undefined;
      };
      const runtime = new TransportSessionRuntime(provider, 'deck_auto_compact');
      await runtime.initialize({ sessionKey: 'deck_auto_compact', identityPrompt: 'identity survives compaction' });
      return { provider, runtime, complete: (m: AgentMessage) => complete?.('provider-session-1', m) };
    }

    it('compacts a nearly full context once the turn ends, through the /compact path', async () => {
      const { provider, runtime, complete } = await setup(true);
      runtime.send('keep going', 'work-1');
      await waitForProviderSend(provider);
      complete(turnDone('turn-1', 214_355));
      await vi.waitFor(() => expect(sentTexts(provider)).toHaveLength(2));
      expect(sentTexts(provider)[1]).toContain('/compact');

      // The compaction completion re-injects the identity on the next turn.
      complete({
        id: 'compact-done', sessionId: 'provider-session-1', kind: 'system', role: 'system',
        content: 'Codex context compacted.', timestamp: Date.now(), status: 'complete',
        metadata: { [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact' },
      });
      expect(provider.refreshSessionSystemText).toHaveBeenCalledWith('provider-session-1');

      // Still high after a compaction that did not help: no loop.
      runtime.send('next', 'work-2');
      await vi.waitFor(() => expect(sentTexts(provider)).toHaveLength(3));
      complete(turnDone('turn-2', 214_000));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sentTexts(provider)).toHaveLength(3);
    });

    it('re-injects after an untagged /compact completion, as Claude\'s slash command gives', async () => {
      const { provider, runtime, complete } = await setup(true);
      runtime.send('/compact', 'compact-1');
      await waitForProviderSend(provider);
      complete({ ...turnDone('compact-1-done', 40_000), metadata: {} });
      expect(provider.refreshSessionSystemText).toHaveBeenCalledWith('provider-session-1');
    });

    it('re-injects after a compaction the provider did on its own mid-turn', async () => {
      const { provider, runtime, complete } = await setup(true);
      runtime.send('long task', 'work-1');
      await waitForProviderSend(provider);
      expect(provider.refreshSessionSystemText).not.toHaveBeenCalled();
      (provider as unknown as { __status?: (sid: string, update: ProviderStatusUpdate) => void }).__status?.('provider-session-1', { status: 'compacting' });
      complete(turnDone('turn-1', 60_000));
      expect(provider.refreshSessionSystemText).toHaveBeenCalledWith('provider-session-1');
    });

    it('uses the model\'s known window when the provider reports none, as Claude does', async () => {
      const { resolveContextWindow } = await import('../../src/util/model-context.js');
      const window = resolveContextWindow(undefined, 'claude-sonnet-4-6');
      const { provider, runtime, complete } = await setup(true);
      runtime.send('keep going', 'work-1');
      await waitForProviderSend(provider);
      const done = turnDone('turn-1', Math.ceil(window * 0.8));
      const usage = { ...(done.metadata!.usage as Record<string, unknown>) };
      delete usage.model_context_window;
      complete({ ...done, metadata: { usage, model: 'claude-sonnet-4-6' } });
      await vi.waitFor(() => expect(sentTexts(provider)).toHaveLength(2));
      expect(sentTexts(provider)[1]).toContain('/compact');
    });

    it('leaves a context below the threshold alone', async () => {
      const { provider, runtime, complete } = await setup(true);
      runtime.send('keep going', 'work-1');
      await waitForProviderSend(provider);
      complete(turnDone('turn-1', 120_000));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sentTexts(provider)).toHaveLength(1);
    });

    it('is off by default: the default ratio is unreachable and a nearly full window is left alone', async () => {
      expect(TRANSPORT_AUTO_COMPACT_CONTEXT_RATIO).toBeGreaterThan(1);
      vi.unstubAllEnvs();
      const { provider, runtime, complete } = await setup(true);
      runtime.send('keep going', 'work-1');
      await waitForProviderSend(provider);
      complete(turnDone('turn-1', Math.floor(258_400 * 0.98)));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sentTexts(provider)).toHaveLength(1);
    });

    it('waits until 75% of the window before compacting when re-enabled at 0.75', async () => {
      const { provider, runtime, complete } = await setup(true);
      runtime.send('keep going', 'work-1');
      await waitForProviderSend(provider);
      complete(turnDone('turn-1', Math.floor(258_400 * 0.72)));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sentTexts(provider)).toHaveLength(1);
    });

    it('auto-compacts a slash-command provider that keeps its identity outside the history', async () => {
      const { provider, runtime, complete } = await setup(true);
      provider.capabilities.compact = { ...provider.capabilities.compact!, execution: 'slash-command', providerCommand: '/compact' };
      runtime.send('keep going', 'work-1');
      await waitForProviderSend(provider);
      complete(turnDone('turn-1', 190_000, 200_000));
      await vi.waitFor(() => expect(sentTexts(provider)).toHaveLength(2));
      expect(sentTexts(provider)[1]).toContain('/compact');
    });

    it('never compacts on its own a provider that does not re-send the identity afterwards', async () => {
      const { provider, runtime, complete } = await setup(undefined);
      runtime.send('keep going', 'work-1');
      await waitForProviderSend(provider);
      complete(turnDone('turn-1', 250_000));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sentTexts(provider)).toHaveLength(1);
    });
  });

  it('invalidates provider-stable system text after a compact completion', async () => {
    let complete: ((sessionId: string, message: AgentMessage) => void) | undefined;
    const provider = makeProvider();
    provider.refreshSessionSystemText = vi.fn();
    provider.onComplete = (callback) => {
      complete = callback;
      return () => undefined;
    };
    const runtime = new TransportSessionRuntime(provider, 'deck_compact_identity');
    await runtime.initialize({
      sessionKey: 'deck_compact_identity',
      identityPrompt: 'session identity must return after compact',
    });

    runtime.send('/compact', 'compact-1');
    await waitForProviderSend(provider);
    expect((provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.sessionSystemText)
      .toBe(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE);
    complete?.('provider-session-1', {
      id: 'compact-done',
      sessionId: 'provider-session-1',
      kind: 'text',
      role: 'assistant',
      content: 'compacted',
      timestamp: Date.now(),
      status: 'complete',
      metadata: { [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact' },
    });

    expect(provider.refreshSessionSystemText).toHaveBeenCalledOnce();
    expect(provider.refreshSessionSystemText).toHaveBeenCalledWith('provider-session-1');

    runtime.send('continue', 'after-compact-1');
    const send = provider.send as ReturnType<typeof vi.fn>;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && send.mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(send.mock.calls[1]?.[1]?.sessionSystemText).toContain('session identity must return after compact');
  });

  it('registers a dynamic cron system contract once per provider thread', async () => {
    let complete: ((sessionId: string, message: AgentMessage) => void) | undefined;
    const provider = makeProvider();
    provider.onComplete = (callback) => {
      complete = callback;
      return () => undefined;
    };
    const runtime = new TransportSessionRuntime(provider, 'deck_cron_contract');
    await runtime.initialize({ sessionKey: 'deck_cron_contract' });
    const registeredSystemContract = {
      contractId: 'supervision_cron_control_v1',
      signature: 'cron-body-v1',
      body: '{"contractId":"supervision_cron_control_v1","authoritative":{"taskBody":"inspect progress"}}',
    };

    runtime.send('cron-ref-1', 'cron-1', undefined, undefined, { registeredSystemContract });
    await waitForProviderSend(provider);
    expect((provider.send as ReturnType<typeof vi.fn>).mock.calls[0][1].systemText)
      .toContain('"taskBody":"inspect progress"');

    complete?.('provider-session-1', {
      id: 'done-1', sessionId: 'provider-session-1', kind: 'text', role: 'assistant',
      content: 'done', timestamp: Date.now(), status: 'complete',
    });
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    (provider.send as ReturnType<typeof vi.fn>).mockClear();

    runtime.send('cron-ref-2', 'cron-2', undefined, undefined, { registeredSystemContract });
    await waitForProviderSend(provider);
    const secondPayload = (provider.send as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(secondPayload.userMessage).toBe('cron-ref-2');
    expect(secondPayload.systemText).not.toContain('inspect progress');
  });

  // The Brain delegation contract is chosen from the session's LIVE supervision
  // mode on every turn. A Brain whose supervision is off must never be handed the
  // automatic task route, and the by-reference shortcut must never let one
  // variant's registration stand in for the other after the mode changes.
  describe('Brain delegation contract follows the live supervision mode', () => {
    // These sessions have no project record, so with no explicit engine
    // choice they would resolve `off` (owner decision, 2026-09-26: pairs is
    // no longer a zero-config default). This block exercises the pairs
    // contract shape specifically, so it opts in via the env override --
    // the same pattern the sibling task-pairs test files use.
    const previousEngine = process.env.IMCODES_SUPERVISION_ENGINE;
    beforeEach(() => {
      process.env.IMCODES_SUPERVISION_ENGINE = 'pairs';
    });
    afterEach(() => {
      if (previousEngine === undefined) delete process.env.IMCODES_SUPERVISION_ENGINE;
      else process.env.IMCODES_SUPERVISION_ENGINE = previousEngine;
    });

    async function brainRuntime(sessionName: string) {
      let complete: ((sessionId: string, message: AgentMessage) => void) | undefined;
      const provider = makeProvider();
      provider.onComplete = (callback) => {
        complete = callback;
        return () => undefined;
      };
      const runtime = new TransportSessionRuntime(provider, sessionName);
      await runtime.initialize({ sessionKey: sessionName });
      runtime.setSessionIdentity(sessionName, 'Brain', 'brain');
      const send = provider.send as ReturnType<typeof vi.fn>;
      let turn = 0;
      const nextTurnText = async (): Promise<string> => {
        turn += 1;
        send.mockClear();
        runtime.send(`turn-${turn}`, `turn-${turn}`);
        await waitForProviderSend(provider);
        const text = String(send.mock.calls[0]?.[1]?.systemText ?? '');
        complete?.('provider-session-1', {
          id: `done-${turn}`, sessionId: 'provider-session-1', kind: 'text', role: 'assistant',
          content: 'done', timestamp: Date.now(), status: 'complete',
        });
        await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
        return text;
      };
      return { runtime, nextTurnText };
    }

    const OFF_BODY = '"automaticSupervision":false';
    const ON_BODY = '"automaticSupervision":true';
    // The env override above opts these Brains into `pairs`, so they carry
    // the pairs Brain contract (never a supervision_* one).
    const FULL = `"contractId":"${TASK_PAIR_BRAIN_CONTRACT_ID}"`;
    const REF = `"contractRef":"${TASK_PAIR_BRAIN_CONTRACT_ID}"`;
    const ON_DUTY = 'send_message_to_one_worker_opens_the_pair';

    it('re-reads the mode every turn and re-registers the full body whenever the variant changes', async () => {
      const { runtime, nextTurnText } = await brainRuntime('deck_mode_switch_brain');
      let mode: 'off' | 'supervised' = 'off';
      runtime.setSupervisionSnapshotResolver(() => ({ mode }));

      const offFirst = await nextTurnText();
      expect(offFirst).toContain(FULL);
      expect(offFirst).toContain(OFF_BODY);
      expect(offFirst).not.toContain(ON_DUTY);

      const offAgain = await nextTurnText();
      expect(offAgain, 'the same variant re-asserts by reference').toContain(REF);
      expect(offAgain).not.toContain(FULL);
      expect(offAgain).toContain(OFF_BODY);

      mode = 'supervised';
      const onFirst = await nextTurnText();
      expect(onFirst, 'an off registration must not satisfy the on variant').toContain(FULL);
      expect(onFirst).toContain(ON_BODY);
      expect(onFirst).toContain(ON_DUTY);

      mode = 'off';
      const offAfterOn = await nextTurnText();
      expect(offAfterOn, 'turning supervision off re-registers the manual-only body').toContain(FULL);
      expect(offAfterOn).toContain(OFF_BODY);
      expect(offAfterOn).not.toContain(ON_DUTY);
      expect(offAfterOn).not.toMatch(/supervision_[a-z_]+_v\d/);
    });

    it('fails closed to the manual-only contract when the mode cannot be established', async () => {
      const unresolved = await brainRuntime('deck_mode_unresolved_brain');
      const noResolver = await unresolved.nextTurnText();
      expect(noResolver).toContain(OFF_BODY);
      expect(noResolver).not.toContain('task_assignment');

      const throwing = await brainRuntime('deck_mode_throwing_brain');
      throwing.runtime.setSupervisionSnapshotResolver(() => { throw new Error('session store unavailable'); });
      const thrown = await throwing.nextTurnText();
      expect(thrown).toContain(OFF_BODY);
      expect(thrown).not.toContain('task_assignment');

      const unknown = await brainRuntime('deck_mode_unknown_brain');
      unknown.runtime.setSupervisionSnapshotResolver(() => ({ mode: 'manual' as never }));
      const unknownText = await unknown.nextTurnText();
      expect(unknownText).toContain(OFF_BODY);
      expect(unknownText).not.toContain('task_assignment');
    });
  });

  it('preserves semantic recent-summary sourceSessionName through emitted memory.context', async () => {
    const result: MemorySearchResult = {
      items: [{
        id: 'semantic-recent-summary',
        type: 'processed',
        projectId: 'github-im4codes/im4codes/imcodes',
        scope: 'personal',
        sourceSessionName: '  deck_current_brain  ',
        projectionClass: 'recent_summary',
        summary: 'Current-window summary selected through semantic recall',
        relevanceScore: 0.95,
        createdAt: 100,
      }],
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
    };
    searchLocalMemorySemanticMock.mockResolvedValue(result);

    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_current_brain');
    runtime.setContextBootstrapResolver(async () => ({
      namespace: { scope: 'personal', projectId: 'github-im4codes/im4codes/imcodes' },
      diagnostics: ['namespace:explicit'],
      localProcessedFreshness: 'fresh',
    }));
    await runtime.initialize({ sessionKey: 'deck_current_brain' });
    timelineEmitterEmitMock.mockClear();

    runtime.send('Continue the current session work', 'current-user-event');
    await waitForProviderSend(provider);

    expect(provider.send).toHaveBeenCalledWith(
      'provider-session-1',
      expect.objectContaining({
        memoryRecall: expect.objectContaining({
          items: [expect.objectContaining({
            projectionClass: 'recent_summary',
            sourceSessionName: 'deck_current_brain',
          })],
        }),
      }),
    );
    expect(timelineEmitterEmitMock).toHaveBeenCalledWith(
      'deck_current_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'transport-user:current-user-event',
        items: [expect.objectContaining({
          projectionClass: 'recent_summary',
          sourceSessionName: 'deck_current_brain',
        })],
      }),
      expect.objectContaining({ source: 'daemon', confidence: 'high' }),
    );

    await runtime.kill();
  });
});

describe('TransportSessionRuntime cross-vendor handoff one-shot guard', () => {
  it('injects on the first ordinary turn and consumes only after provider acceptance', async () => {
    const provider = makeProvider();
    const send = provider.send as ReturnType<typeof vi.fn>;
    let complete: ((sessionId: string, message: AgentMessage) => void) | undefined;
    provider.onComplete = (callback) => { complete = callback; return () => undefined; };
    const runtime = new TransportSessionRuntime(provider, 'handoff-one-shot');
    await runtime.initialize({
      sessionKey: 'handoff-one-shot',
      pendingHandoff: {
        text: 'IM.codes cross-vendor handoff\nNon-authoritative prior context',
        sourceAgentType: 'claude-code-sdk', sourceRuntimeType: 'transport',
        sourceConversationKey: 'cc-native', cutoff: { epoch: 1, seq: 2, ts: 3 },
        createdAt: Date.now(), tokenCount: 8,
      },
    });
    runtime.send('first', 'first-id');
    await waitForProviderSend(provider);
    expect(send.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ messagePreamble: expect.stringContaining('Non-authoritative prior context') }));
    complete?.('provider-session-1', { id: 'done-1', sessionId: 'provider-session-1', kind: 'text', role: 'assistant', content: 'ok', timestamp: Date.now(), status: 'complete' });
    await vi.waitFor(() => expect(runtime.getStatus()).toBe('idle'));
    send.mockClear();
    runtime.send('second', 'second-id');
    await waitForProviderSend(provider);
    expect(send.mock.calls[0]?.[1]?.messagePreamble ?? '').not.toContain('Non-authoritative prior context');
    await runtime.kill();
  });

  it('retains the handoff when the provider rejects the first send', async () => {
    const provider = makeProvider();
    const send = provider.send as ReturnType<typeof vi.fn>;
    send.mockRejectedValueOnce(new Error('provider busy')).mockResolvedValue(undefined);
    const runtime = new TransportSessionRuntime(provider, 'handoff-retry');
    await runtime.initialize({
      sessionKey: 'handoff-retry',
      pendingHandoff: {
        text: 'Non-authoritative prior context', sourceAgentType: 'claude-code-sdk', sourceRuntimeType: 'transport',
        cutoff: { epoch: 1, seq: 2, ts: 3 }, createdAt: Date.now(), tokenCount: 4,
      },
    });
    runtime.send('first', 'retry-first');
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    send.mockClear();
    runtime.send('retry', 'retry-second');
    await waitForProviderSend(provider);
    expect(send.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ messagePreamble: expect.stringContaining('Non-authoritative prior context') }));
    await runtime.kill();
  });
});

it('consumes handoff before a late STOP cancellation can trigger a duplicate retry', async () => {
  const provider = makeProvider();
  const send = provider.send as ReturnType<typeof vi.fn>;
  const runtime = new TransportSessionRuntime(provider, 'handoff-cancel-race');
  await runtime.initialize({
    sessionKey: 'handoff-cancel-race',
    pendingHandoff: {
      text: 'Non-authoritative prior context', sourceAgentType: 'claude-code-sdk', sourceRuntimeType: 'transport',
      cutoff: { epoch: 1, seq: 2, ts: 3 }, createdAt: Date.now(), tokenCount: 4,
    },
  });
  let stopIssued = false;
  send.mockImplementationOnce(async () => {
    if (!stopIssued) {
      stopIssued = true;
      await runtime.cancel();
    }
  });
  runtime.send('first', 'cancel-first');
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  send.mockClear();
  runtime.send('retry', 'cancel-retry');
  await waitForProviderSend(provider);
  expect(send.mock.calls[0]?.[1]?.messagePreamble ?? '').not.toContain('Non-authoritative prior context');
  await runtime.kill();
});

it('returns session.send acknowledgement before a slow handoff build and proceeds after the bounded wait', async () => {
  const provider = makeProvider();
  const runtime = new TransportSessionRuntime(provider, 'handoff-ack-order');
  await runtime.initialize({ sessionKey: 'handoff-ack-order' });
  runtime.setPendingHandoffReady(new Promise(() => undefined));
  const started = Date.now();
  const result = runtime.send('ordinary', 'ack-order');
  expect(result).toBe('sent');
  expect(Date.now() - started).toBeLessThan(250);
  await waitForProviderSend(provider);
  await runtime.kill();
});
