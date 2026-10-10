import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type { ProviderError, ProviderStatusUpdate, ProviderUsageUpdate, ToolCallEvent, TransportProvider } from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import type { TransportContextBootstrap } from '../../src/agent/runtime-context-bootstrap.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import { resetContextStoreClientForTests } from '../../src/store/context-store-worker-client.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn() },
}));

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
  await vi.waitFor(() => expect(send).toHaveBeenCalled(), { timeout: 5_000 });
}

const NAMESPACE = { scope: 'personal', projectId: 'github-im4codes/im4codes/imcodes' } as const;
const STARTUP_MEMORY = {
  reason: 'startup',
  runtimeFamily: 'transport',
  authoritySource: 'processed_local',
  sourceKind: 'local_processed',
  injectionSurface: 'message-preamble',
  items: [{
    id: 'mem-1', type: 'processed', projectId: NAMESPACE.projectId, scope: 'personal',
    projectionClass: 'durable_memory_candidate', summary: 'LATE-STARTUP-MEMORY', createdAt: 1, updatedAt: 1,
    sourceKind: 'local_processed',
  }],
  injectedText: 'LATE-STARTUP-MEMORY',
} as unknown as NonNullable<TransportContextBootstrap['startupMemory']>;

function controllable<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('TransportSessionRuntime deferred launch bootstrap', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
    resetAllSummarySyncHistories();
    vi.stubEnv('IMCODES_TRANSPORT_CONTEXT_BUDGET_MS', '150');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetTransportQueueStoreForTests();
    resetContextStoreClientForTests();
  });

  it('initialize does not spend the context budget a second time when the launch already gave up on the bootstrap', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_deferred_init');
    const resolver = vi.fn(() => new Promise<TransportContextBootstrap>(() => { /* backed-up store: never answers */ }));
    runtime.setContextBootstrapResolver(resolver);
    runtime.deferContextBootstrap(new Promise<TransportContextBootstrap>(() => { /* still running */ }));

    const startedAt = Date.now();
    await runtime.initialize({ sessionKey: 'deck_deferred_init' });
    const elapsed = Date.now() - startedAt;

    expect(resolver).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(120);
    await runtime.kill();
  });

  it('control: without a deferred bootstrap initialize still runs (and is capped by) its own bounded refresh', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_plain_init');
    const resolver = vi.fn(() => new Promise<TransportContextBootstrap>(() => { /* never answers */ }));
    runtime.setContextBootstrapResolver(resolver);

    const startedAt = Date.now();
    await runtime.initialize({ sessionKey: 'deck_plain_init' });
    const elapsed = Date.now() - startedAt;

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2_000);
    await runtime.kill();
  });

  it('a late bootstrap that arrives before the first turn injects its startup memory into that turn', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_late_memory');
    const late = controllable<TransportContextBootstrap>();
    runtime.setContextBootstrapResolver(() => late.promise);
    runtime.deferContextBootstrap(late.promise);
    await runtime.initialize({ sessionKey: 'deck_late_memory' });

    late.resolve({ namespace: NAMESPACE, diagnostics: ['namespace:explicit'], localProcessedFreshness: 'fresh', startupMemory: STARTUP_MEMORY });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.send('first turn', 'first-turn-event');
    await waitForProviderSend(provider);
    expect(provider.send).toHaveBeenCalledWith(
      'provider-session-1',
      expect.objectContaining({ startupMemory: expect.objectContaining({ injectedText: 'LATE-STARTUP-MEMORY' }) }),
    );
    await runtime.kill();
  });

  it('the first dispatch waits on the still-running bootstrap instead of starting a second copy, and never past the budget', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_dedupe');
    const pending = controllable<TransportContextBootstrap>();
    const resolver = vi.fn(() => new Promise<TransportContextBootstrap>(() => { /* would pile onto the same backed-up store */ }));
    runtime.setContextBootstrapResolver(resolver);
    runtime.deferContextBootstrap(pending.promise);
    await runtime.initialize({ sessionKey: 'deck_dedupe' });

    runtime.send('hello', 'hello-event');
    await waitForProviderSend(provider);

    expect(resolver).not.toHaveBeenCalled();
    expect((provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.startupMemory).toBeUndefined();
    await runtime.kill();
  });

  it('a deferred bootstrap that fails is forgotten: the next dispatch resolves a fresh one', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_deferred_failed');
    const failing = controllable<TransportContextBootstrap>();
    const resolver = vi.fn(async (): Promise<TransportContextBootstrap> => ({
      namespace: NAMESPACE, diagnostics: ['namespace:explicit'], localProcessedFreshness: 'fresh', startupMemory: STARTUP_MEMORY,
    }));
    runtime.setContextBootstrapResolver(resolver);
    runtime.deferContextBootstrap(failing.promise);
    await runtime.initialize({ sessionKey: 'deck_deferred_failed' });

    failing.reject(new Error('context store worker lost'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.send('hello', 'hello-event');
    await waitForProviderSend(provider);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(provider.send).toHaveBeenCalledWith(
      'provider-session-1',
      expect.objectContaining({ startupMemory: expect.objectContaining({ injectedText: 'LATE-STARTUP-MEMORY' }) }),
    );
    await runtime.kill();
  });

  it('a late result is dropped when something newer was already applied', async () => {
    const provider = makeProvider();
    const runtime = new TransportSessionRuntime(provider, 'deck_late_stale');
    const late = controllable<TransportContextBootstrap>();
    // The dispatch-phase refresh can not answer either (times out), so only `_startupMemory` set by a late
    // apply could reach the provider — which is exactly what the generation guard must prevent here.
    runtime.setContextBootstrapResolver(() => new Promise<TransportContextBootstrap>(() => { /* never answers */ }));
    runtime.deferContextBootstrap(late.promise);
    await runtime.initialize({ sessionKey: 'deck_late_stale' });
    // Anything that lands through the normal path bumps the generation the late result is measured against.
    (runtime as unknown as { applyContextBootstrap(b: Partial<TransportContextBootstrap>): void }).applyContextBootstrap({
      namespace: NAMESPACE, diagnostics: ['newer'],
    });

    late.resolve({ namespace: NAMESPACE, diagnostics: ['older-late'], localProcessedFreshness: 'fresh', startupMemory: STARTUP_MEMORY });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.send('hello', 'hello-event');
    await waitForProviderSend(provider);
    expect((provider.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.startupMemory).toBeUndefined();
    await runtime.kill();
  });
});
