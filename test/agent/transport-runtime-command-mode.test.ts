/**
 * Command mode on the real TransportSessionRuntime: a command-mode message
 * reaches the provider as exactly its own text (no recall, startup memory,
 * preamble, identity or handoff), is never merged with neighbouring queued
 * text, survives the durable queue round trip, and an ordinary message keeps
 * its enrichment (counterexample).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderError, ProviderStatusUpdate, ProviderUsageUpdate, ToolCallEvent, TransportProvider } from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { MemorySearchResult } from '../../src/context/memory-search.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
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
  return { ...original, collectRecentSummarySyncCandidates: collectRecentSummarySyncCandidatesMock };
});

function makeProvider(id: string): TransportProvider {
  return {
    id,
    connectionMode: 'persistent',
    sessionOwnership: 'provider',
    capabilities: {
      streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false,
      contextSupport: 'full-normalized-context-injection',
    },
    connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), cancel: vi.fn(),
    createSession: vi.fn().mockResolvedValue('provider-session-1'),
    endSession: vi.fn(),
    onDelta: (_cb: (sessionId: string, delta: MessageDelta) => void) => () => undefined,
    onComplete: (_cb: (sessionId: string, message: AgentMessage) => void) => () => undefined,
    onError: (_cb: (sessionId: string, error: ProviderError) => void) => () => undefined,
    onApprovalRequest: () => undefined,
    onStatus: (_cb: (sessionId: string, status: ProviderStatusUpdate) => void) => () => undefined,
    onUsage: (_cb: (sessionId: string, update: ProviderUsageUpdate) => void) => () => undefined,
    onToolCall: (_cb: (sessionId: string, toolCall: ToolCallEvent) => void) => () => undefined,
    respondApproval: vi.fn().mockResolvedValue(undefined),
  } as TransportProvider;
}

const RECALL: MemorySearchResult = {
  items: [{
    id: 'recall-1', type: 'processed', projectId: 'github-im4codes/im4codes/imcodes', scope: 'personal',
    projectionClass: 'recent_summary', summary: 'A prior summary that recall would inject', relevanceScore: 0.95, createdAt: 100,
  }],
  stats: {
    totalRecords: 1, matchedRecords: 1, recentSummaryCount: 1, durableCandidateCount: 0,
    projectCount: 1, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0,
  },
};

const HANDOFF = {
  text: 'IM.codes cross-vendor handoff\nNon-authoritative prior context',
  sourceAgentType: 'claude-code-sdk', sourceRuntimeType: 'transport',
  sourceConversationKey: 'cc-native', cutoff: { epoch: 1, seq: 2, ts: 3 },
  createdAt: Date.now(), tokenCount: 8,
} as const;

type Captured = { userMessage: string; assembledMessage: string; messagePreamble?: string; memoryRecall?: unknown; startupMemory?: unknown; sessionSystemText?: string };
const payloads = (provider: TransportProvider): Captured[] => (provider.send as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1] as Captured);

async function waitForSends(provider: TransportProvider, count: number): Promise<void> {
  await vi.waitFor(() => expect((provider.send as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(count), { timeout: 5_000 });
}

async function makeRuntime(providerId: string, sessionKey: string) {
  let complete: ((sessionId: string, message: AgentMessage) => void) | undefined;
  const provider = makeProvider(providerId);
  provider.onComplete = (callback) => { complete = callback; return () => undefined; };
  const runtime = new TransportSessionRuntime(provider, sessionKey);
  runtime.setContextBootstrapResolver(async () => ({
    namespace: { scope: 'personal', projectId: 'github-im4codes/im4codes/imcodes' },
    diagnostics: ['namespace:explicit'],
    localProcessedFreshness: 'fresh',
  }));
  await runtime.initialize({
    sessionKey,
    identityPrompt: 'Session identity that ordinary turns carry',
    description: 'Session description that ordinary turns carry',
    pendingHandoff: { ...HANDOFF },
  });
  const finish = (id: string) => complete?.('provider-session-1', {
    id, sessionId: 'provider-session-1', kind: 'text', role: 'assistant', content: 'done',
    timestamp: Date.now(), status: 'complete',
  } as AgentMessage);
  return { provider, runtime, finish };
}

describe('TransportSessionRuntime command mode', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    resetAllSummarySyncHistories();
    timelineEmitterEmitMock.mockReset();
    searchLocalMemorySemanticMock.mockReset().mockResolvedValue(RECALL);
    collectRecentSummarySyncCandidatesMock.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
  });

  it.each(['claude-code-sdk', 'codex-sdk'])('%s: a command reaches the provider as exactly its text, with none of the enrichment an ordinary turn carries', async (providerId) => {
    // Counterexample first: the identical runtime configuration enriches an ordinary message.
    const ordinary = await makeRuntime(providerId, `deck_cmdmode_ord_${providerId}`);
    ordinary.runtime.send('Continue the current session work', 'ordinary-1', undefined, 'Per-turn preamble');
    await waitForSends(ordinary.provider, 1);
    const [ord] = payloads(ordinary.provider);
    expect(ord!.memoryRecall).toBeDefined();
    expect(ord!.messagePreamble).toContain('Per-turn preamble');
    expect(ord!.messagePreamble).toContain('handoff');
    expect(ord!.sessionSystemText).toContain('Session identity that ordinary turns carry');

    const command = await makeRuntime(providerId, `deck_cmdmode_cmd_${providerId}`);
    const raw = 'first line\n  second line — 第三行 ✓';
    command.runtime.send(raw, 'command-1', undefined, 'Per-turn preamble', { commandMode: true });
    await waitForSends(command.provider, 1);
    const [cmd] = payloads(command.provider);
    expect(Buffer.from(cmd!.userMessage).equals(Buffer.from(raw))).toBe(true);
    expect(Buffer.from(cmd!.assembledMessage).equals(Buffer.from(raw))).toBe(true);
    expect(cmd!.memoryRecall).toBeUndefined();
    expect(cmd!.startupMemory).toBeUndefined();
    expect(cmd!.messagePreamble).toBeUndefined();
    expect(cmd!.sessionSystemText ?? '').not.toContain('Session identity that ordinary turns carry');
    expect(searchLocalMemorySemanticMock).toHaveBeenCalledTimes(1); // the ordinary turn only

    // The one-shot handoff was not consumed by the command: the next ordinary turn still carries it.
    command.finish('command-done');
    command.runtime.send('now something ordinary', 'ordinary-after');
    await waitForSends(command.provider, 2);
    expect(payloads(command.provider)[1]!.messagePreamble).toContain('handoff');
  });

  it('a busy runtime queues the command and delivers it alone, never merged with neighbouring queued text', async () => {
    const { provider, runtime, finish } = await makeRuntime('claude-code-sdk', 'deck_cmdmode_queue');
    runtime.send('turn one', 'turn-one');
    await waitForSends(provider, 1);
    expect(runtime.send('ordinary before', 'before')).toBe('queued');
    expect(runtime.send('/compact-like raw command', 'cmd', undefined, undefined, { commandMode: true })).toBe('queued');
    expect(runtime.send('ordinary after', 'after')).toBe('queued');

    finish('turn-one-done');
    await waitForSends(provider, 2);
    expect(payloads(provider)[1]!.userMessage).toBe('ordinary before');

    finish('before-done');
    await waitForSends(provider, 3);
    const commandTurn = payloads(provider)[2]!;
    expect(commandTurn.userMessage).toBe('/compact-like raw command');
    expect(commandTurn.assembledMessage).toBe('/compact-like raw command');
    expect(commandTurn.messagePreamble).toBeUndefined();

    finish('command-done');
    await waitForSends(provider, 4);
    expect(payloads(provider)[3]!.userMessage).toBe('ordinary after');
  });

  it('a queued command carries its marker through the durable queue and a daemon restart', async () => {
    const before = await makeRuntime('codex-sdk', 'deck_cmdmode_durable');
    before.runtime.send('turn one', 'turn-one');
    await waitForSends(before.provider, 1);
    before.runtime.send('durable raw command', 'cmd', undefined, undefined, { commandMode: true });
    expect(getTransportQueueStore().readSnapshot('deck_cmdmode_durable', 'test').pendingMessageEntries?.map((e) => e.clientMessageId)).toEqual(['cmd']);

    // A daemon restart: the SQLite queue survives, every in-memory runtime is gone.
    const after = await makeRuntime('codex-sdk', 'deck_cmdmode_durable');
    expect(after.runtime.rehydratePendingFromStore()).toBe(1);
    expect(after.runtime.drainPendingIfIdle('restart')).toBe(true);
    await waitForSends(after.provider, 1);
    const [turn] = payloads(after.provider);
    expect(turn!.userMessage).toBe('durable raw command');
    expect(turn!.assembledMessage).toBe('durable raw command');
    expect(turn!.memoryRecall).toBeUndefined();
    expect(turn!.messagePreamble).toBeUndefined();
  });

  it('a native append never joins a command with another queued message', async () => {
    const provider = makeProvider('claude-code-sdk');
    provider.capabilities = { ...provider.capabilities, activeDelegationNotification: 'native' } as never;
    provider.notifyActiveDelegation = vi.fn().mockResolvedValue('delivered');
    const runtime = new TransportSessionRuntime(provider, 'deck_cmdmode_append');
    await runtime.initialize({ sessionKey: 'deck_cmdmode_append' });
    runtime.send('turn one', 'turn-one');
    await waitForSends(provider, 1);
    runtime.send('ordinary', 'ord');
    runtime.send('raw command', 'cmd', undefined, undefined, { commandMode: true });
    // Two queued rows selected for one native append would be joined into one provider text.
    expect(await runtime.appendPendingMessagesToActiveTurn(['ord', 'cmd'], 'note-1')).toEqual({ status: 'control_unsupported' });
    expect(provider.notifyActiveDelegation).not.toHaveBeenCalled();
    // A command alone may still ride a native append, as exactly its own text.
    expect(await runtime.appendPendingMessagesToActiveTurn(['cmd'], 'note-2')).toMatchObject({ status: 'delivered' });
    expect(provider.notifyActiveDelegation).toHaveBeenCalledWith('provider-session-1', expect.objectContaining({ text: 'raw command' }));
  });
});
