import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderError, ProviderStatusUpdate, ProviderUsageUpdate, ToolCallEvent, TransportProvider } from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';

const emit = vi.hoisted(() => vi.fn());
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit } }));
vi.mock('../../src/context/memory-search.js', () => ({ searchLocalMemory: vi.fn(), searchLocalMemorySemantic: vi.fn().mockResolvedValue({ items: [], stats: {} }) }));

function makeProvider(): TransportProvider {
  return {
    id: 'test-transport', connectionMode: 'persistent', sessionOwnership: 'provider',
    capabilities: { streaming: true, toolCalling: false, approval: false, sessionRestore: false, multiTurn: true, attachments: false, contextSupport: 'full-normalized-context-injection' },
    connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), cancel: vi.fn(),
    createSession: vi.fn().mockResolvedValue('provider-session-1'), endSession: vi.fn(),
    onDelta: (_cb: (s: string, d: MessageDelta) => void) => () => undefined,
    onComplete: (_cb: (s: string, m: AgentMessage) => void) => () => undefined,
    onError: (_cb: (s: string, e: ProviderError) => void) => () => undefined,
    onApprovalRequest: () => undefined,
    onStatus: (_cb: (s: string, st: ProviderStatusUpdate) => void) => () => undefined,
    onUsage: (_cb: (s: string, u: ProviderUsageUpdate) => void) => () => undefined,
    onToolCall: (_cb: (s: string, t: ToolCallEvent) => void) => () => undefined,
    respondApproval: vi.fn().mockResolvedValue(undefined),
  } as TransportProvider;
}
const until = async (fn: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } };

describe('ask.answer fallback path (front queue + cancel) with the real runtime', () => {
  beforeEach(() => { resetTransportQueueStoreForTests(); resetContextStoreClientForTests(); emit.mockReset(); });
  afterEach(() => { resetTransportQueueStoreForTests(); resetContextStoreClientForTests(); });

  it('delivers the answer as the next turn while the active turn is paused on the question', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_ask_probe');
    await runtime.initialize({ sessionKey: 'deck_ask_probe' } as never);
    const send = provider.send as ReturnType<typeof vi.fn>;
    expect(runtime.send('start the work')).toBe('sent');
    await until(() => send.mock.calls.length >= 1);
    expect(send.mock.calls).toHaveLength(1); // turn is now "paused" (never completes)

    const result = runtime.send('PICKED-B', undefined, undefined, undefined, { queuePlacement: 'front' });
    expect(result).toBe('queued');
    await runtime.cancel();
    await until(() => send.mock.calls.length >= 2);

    expect(send.mock.calls).toHaveLength(2);
    expect(JSON.stringify(send.mock.calls[1])).toContain('PICKED-B');
  });

  it('does not drop an answer whose text equals the text already sent this turn (Yes / 是 / 继续)', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_ask_probe2');
    await runtime.initialize({ sessionKey: 'deck_ask_probe2' } as never);
    const send = provider.send as ReturnType<typeof vi.fn>;
    expect(runtime.send('Yes')).toBe('sent');
    await until(() => send.mock.calls.length >= 1);
    expect(runtime.send('Yes', undefined, undefined, undefined, { queuePlacement: 'front' })).toBe('queued');
    await runtime.cancel();
    await until(() => send.mock.calls.length >= 2);
    expect(send.mock.calls).toHaveLength(2);
  });
});
