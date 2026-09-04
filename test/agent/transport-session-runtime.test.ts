import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderError, ProviderStatusUpdate, ProviderUsageUpdate, ToolCallEvent, TransportProvider } from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { MemorySearchResult } from '../../src/context/memory-search.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';

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
