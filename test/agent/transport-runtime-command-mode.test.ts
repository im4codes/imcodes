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

async function nativeAppendHarness(sessionKey: string) {
  const harness = await makeRuntime('claude-code-sdk', sessionKey);
  harness.provider.capabilities = { ...harness.provider.capabilities, activeDelegationNotification: 'native' } as never;
  harness.provider.notifyActiveDelegation = vi.fn().mockResolvedValue('delivered');
  harness.runtime.send('foreground', 'foreground');
  await waitForSends(harness.provider, 1);
  return harness;
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

  it.each([0, 1, 2])('native append splits command at position %s without making the entire mixed queue wait idle', async (commandPosition) => {
    const provider = makeProvider('claude-code-sdk');
    provider.capabilities = { ...provider.capabilities, activeDelegationNotification: 'native' } as never;
    provider.notifyActiveDelegation = vi.fn().mockResolvedValue('delivered');
    const runtime = new TransportSessionRuntime(provider, 'deck_cmdmode_append');
    await runtime.initialize({ sessionKey: 'deck_cmdmode_append' });
    runtime.send('turn one', 'turn-one');
    await waitForSends(provider, 1);
    const texts = ['ordinary before\n中文', 'ordinary after'];
    texts.splice(commandPosition, 0, 'raw command\n  原文');
    for (const [index, text] of texts.entries()) runtime.send(text, `mixed-${index}`, undefined, undefined,
      index === commandPosition ? { commandMode: true } : undefined);
    const result = await runtime.appendPendingMessagesToActiveTurn(['mixed-0', 'mixed-1', 'mixed-2'], 'note-mixed');
    expect(result).toMatchObject({ status: 'delivered' });
    const admissions = (provider.notifyActiveDelegation as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].text);
    expect(admissions).toEqual(commandPosition === 0 ? [texts[0], texts.slice(1).join('\n\n')]
      : commandPosition === 2 ? [texts.slice(0, 2).join('\n\n'), texts[2]] : texts);
    expect(runtime.pendingEntries).toEqual([]);
    expect(provider.cancel).not.toHaveBeenCalled();
    expect(provider.send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) expect(getTransportQueueStore().hasDeliveryTombstone('deck_cmdmode_append', `mixed-${i}`)).toBe(true);
  });
  it.each(['unsupported', 'stale'])('one command returning %s publishes partial truth and does not strand later text', async (status) => {
    const { runtime, provider } = await nativeAppendHarness('deck_cmdmode_partial');
    provider.notifyActiveDelegation = vi.fn(async (_session, notification) => notification.text === 'raw command' ? status : 'delivered') as never;
    runtime.send('before', 'before');
    runtime.send('raw command', 'cmd', undefined, undefined, { commandMode: true });
    runtime.send('after', 'after');
    const result = await runtime.appendPendingMessagesToActiveTurn(['before', 'cmd', 'after'], 'partial');
    expect(result).toEqual({ status });
    expect((provider.notifyActiveDelegation as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].text)).toEqual(['before', 'raw command', 'after']);
    expect(runtime.pendingEntries.map((entry) => entry.clientMessageId)).toEqual(['cmd']);
    expect(getTransportQueueStore().hasDeliveryTombstone('deck_cmdmode_partial', 'cmd')).toBe(false);
    for (const id of ['before', 'after']) {
      expect(getTransportQueueStore().hasDeliveryTombstone('deck_cmdmode_partial', id)).toBe(true);
      expect(timelineEmitterEmitMock.mock.calls.filter((call) => call[1] === 'transport.queue.delivery' && call[2].clientMessageId === id)).toHaveLength(1);
    }
    expect(provider.cancel).not.toHaveBeenCalled();
    // Retry only the unadmitted command. Already accepted neighbours remain gone.
    (provider.notifyActiveDelegation as ReturnType<typeof vi.fn>).mockResolvedValue('delivered');
    expect(await runtime.appendPendingMessagesToActiveTurn(['cmd'], 'retry')).toMatchObject({ status: 'delivered' });
    expect(runtime.pendingEntries).toEqual([]);
    expect(await runtime.appendPendingMessagesToActiveTurn(['before', 'cmd', 'after'], 'duplicate')).toEqual({ status: 'not_found' });
    expect(provider.notifyActiveDelegation).toHaveBeenCalledTimes(4);
  });

  it('keeps consecutive commands as separate native inputs and compact on its dedicated SDK path', async () => {
    const { runtime, provider } = await nativeAppendHarness('deck_cmdmode_controls');
    runtime.send('command 1', 'cmd1', undefined, undefined, { commandMode: true });
    runtime.send('command 2', 'cmd2', undefined, undefined, { commandMode: true });
    runtime.send('/compact', 'compact', undefined, undefined, { commandMode: true });
    runtime.send('ordinary', 'ordinary');
    expect(await runtime.appendPendingMessagesToActiveTurn(['cmd1', 'cmd2', 'compact', 'ordinary'], 'controls')).toEqual({ status: 'control_unsupported' });
    expect((provider.notifyActiveDelegation as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].text)).toEqual(['command 1', 'command 2', 'ordinary']);
    expect(runtime.pendingEntries.map((entry) => entry.clientMessageId)).toEqual(['compact']);
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it.each(['edit', 'withdraw', 'revoke'])('a delayed command does not replay accepted rows or swallow a later %s/new arrival', async (action) => {
    const { runtime, provider } = await nativeAppendHarness('deck_cmdmode_delayed');
    let release!: (result: 'delivered') => void;
    provider.notifyActiveDelegation = vi.fn(async (_session, notification) => notification.text === 'command'
      ? new Promise<'delivered'>((resolve) => { release = resolve; }) : 'delivered') as never;
    runtime.send('before', 'before');
    runtime.send('command', 'cmd', undefined, undefined, { commandMode: true });
    runtime.send('after', 'after');
    const admission = runtime.appendPendingMessagesToActiveTurn(['before', 'cmd', 'after'], 'delayed');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(getTransportQueueStore().hasDeliveryTombstone('deck_cmdmode_delayed', 'before')).toBe(true);
    expect(getTransportQueueStore().hasDeliveryTombstone('deck_cmdmode_delayed', 'cmd')).toBe(false);
    runtime.send('new arrival outside frozen selection', 'new');
    if (action === 'edit') expect(runtime.editPendingMessage('after', 'after edited')).toBe(true);
    if (action === 'withdraw') expect(runtime.removePendingMessage('after')).not.toBeNull();
    if (action === 'revoke') runtime.pendingDrainAdmission = (entry) => entry.clientMessageId === 'after' ? 'stale' : 'authorized';
    release('delivered');
    const result = await admission;
    expect(result.status).toBe(action === 'edit' ? 'delivered' : action === 'withdraw' ? 'not_found' : 'rejected');
    expect((provider.notifyActiveDelegation as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].text)).toEqual(
      action === 'edit' ? ['before', 'command', 'after edited'] : ['before', 'command']);
    expect(runtime.pendingEntries.map((entry) => entry.clientMessageId)).toEqual(['new']);
    expect(getTransportQueueStore().hasDeliveryTombstone('deck_cmdmode_delayed', 'cmd')).toBe(true);
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it('restores commandMode and append intent from durable metadata without merging the command into ordinary text', async () => {
    const before = await makeRuntime('claude-code-sdk', 'deck_cmdmode_restore_native');
    before.provider.capabilities = { ...before.provider.capabilities, activeDelegationNotification: 'native' } as never;
    before.provider.notifyActiveDelegation = vi.fn().mockResolvedValue('delivered');
    before.provider.send = vi.fn(() => new Promise<void>(() => {}));
    before.runtime.send('old foreground', 'old-foreground');
    await waitForSends(before.provider, 1);
    before.runtime.send('command 原文', 'cmd', undefined, undefined, { commandMode: true, deliveryMode: 'append' });
    before.runtime.send('ordinary 中文', 'ord', undefined, undefined, { deliveryMode: 'append' });
    await before.runtime.kill({ preserveTransportQueue: true });
    const after = await nativeAppendHarness('deck_cmdmode_restore_native');
    expect(after.runtime.rehydratePendingFromStore()).toBe(2);
    const result = await after.runtime.appendPendingMessagesToActiveTurn(['cmd', 'ord'], 'restored-native');
    expect(result.status).toBe('delivered');
    expect((after.provider.notifyActiveDelegation as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].text)).toEqual(['command 原文', 'ordinary 中文']);
    expect(after.runtime.pendingEntries).toEqual([]);
    await after.runtime.kill({ preserveTransportQueue: true });
  });

  it('handles the 200-entry command append limit with one native admission per id and no replay', async () => {
    const { runtime, provider } = await nativeAppendHarness('deck_cmdmode_limit');
    const ids = Array.from({ length: 200 }, (_, index) => `command-${index}`);
    for (const [index, id] of ids.entries()) runtime.send(`command ${index} 中文\n${'x'.repeat(1024)}`, id, undefined, undefined, { commandMode: true });
    const started = performance.now();
    const result = await runtime.appendPendingMessagesToActiveTurn(ids, 'command-limit');
    console.info('command-append-200 fixture milliseconds', performance.now() - started);
    expect(result.status).toBe('delivered');
    expect(provider.notifyActiveDelegation).toHaveBeenCalledTimes(200);
    expect(runtime.pendingEntries).toEqual([]);
    expect(provider.cancel).not.toHaveBeenCalled();
    expect(getTransportQueueStore().readSnapshot('deck_cmdmode_limit').pendingMessageEntries).toEqual([]);
    await runtime.kill({ preserveTransportQueue: true });
  }, 30_000);

});
