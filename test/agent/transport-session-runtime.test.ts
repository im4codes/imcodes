import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderError, ProviderStatusUpdate, ProviderUsageUpdate, ToolCallEvent, TransportProvider } from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { MemorySearchResult } from '../../src/context/memory-search.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD } from '../../shared/session-control-commands.js';
import { CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE } from '../../shared/cron-types.js';

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
    const FULL = '"contractId":"supervision_brain_work_delegation_v1"';
    const REF = '"contractRef":"supervision_brain_work_delegation_v1"';

    it('re-reads the mode every turn and re-registers the full body whenever the variant changes', async () => {
      const { runtime, nextTurnText } = await brainRuntime('deck_mode_switch_brain');
      let mode: 'off' | 'supervised' = 'off';
      runtime.setSupervisionSnapshotResolver(() => ({ mode }));

      const offFirst = await nextTurnText();
      expect(offFirst).toContain(FULL);
      expect(offFirst).toContain(OFF_BODY);
      expect(offFirst).not.toContain('task_assignment');

      const offAgain = await nextTurnText();
      expect(offAgain, 'the same variant re-asserts by reference').toContain(REF);
      expect(offAgain).not.toContain(FULL);
      expect(offAgain).toContain(OFF_BODY);

      mode = 'supervised';
      const onFirst = await nextTurnText();
      expect(onFirst, 'an off registration must not satisfy the on variant').toContain(FULL);
      expect(onFirst).toContain(ON_BODY);
      expect(onFirst).toContain('task_assignment');

      mode = 'off';
      const offAfterOn = await nextTurnText();
      expect(offAfterOn, 'turning supervision off re-registers the manual-only body').toContain(FULL);
      expect(offAfterOn).toContain(OFF_BODY);
      expect(offAfterOn).not.toContain('task_assignment');
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
