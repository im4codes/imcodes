import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';
import type {
  ProviderError,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  ToolCallEvent,
  TransportProvider,
} from '../../src/agent/transport-provider.js';
import { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

const timelineEmitterEmitMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: timelineEmitterEmitMock },
}));

function makeHarness() {
  let onStatusCb: ((sid: string, status: ProviderStatusUpdate) => void) | undefined;
  let onCompleteCb: ((sid: string, msg: AgentMessage) => void) | undefined;
  let onErrorCb: ((sid: string, err: ProviderError) => void) | undefined;

  const checkSessionCompaction = vi.fn(async () => false);
  const cancel = vi.fn(async () => undefined);
  const send = vi.fn(async () => undefined);

  const provider: TransportProvider = {
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
    send,
    cancel,
    createSession: vi.fn().mockResolvedValue('provider-session-1'),
    endSession: vi.fn(),
    checkSessionCompaction,
    onDelta: (_cb: (sid: string, d: MessageDelta) => void) => () => undefined,
    onComplete: (cb: (sid: string, msg: AgentMessage) => void) => {
      onCompleteCb = cb;
      return () => undefined;
    },
    onError: (cb: (sid: string, err: ProviderError) => void) => {
      onErrorCb = cb;
      return () => undefined;
    },
    onApprovalRequest: () => undefined,
    onStatus: (cb: (sid: string, s: ProviderStatusUpdate) => void) => {
      onStatusCb = cb;
      return () => undefined;
    },
    onUsage: (_cb: (sid: string, u: ProviderUsageUpdate) => void) => () => undefined,
    onToolCall: (_cb: (sid: string, t: ToolCallEvent) => void) => () => undefined,
    respondApproval: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;

  const runtime = new TransportSessionRuntime(provider, 'deck_proj_brain');
  return {
    runtime,
    provider,
    send,
    cancel,
    checkSessionCompaction,
    emitStatus: (status: ProviderStatusUpdate) => onStatusCb?.('provider-session-1', status),
    emitComplete: (msg: Partial<AgentMessage>) => onCompleteCb?.('provider-session-1', {
      id: 'm1',
      role: 'assistant',
      content: 'ok',
      timestamp: Date.now(),
      ...msg,
    } as AgentMessage),
    emitError: (err: ProviderError) => onErrorCb?.('provider-session-1', err),
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 15));

describe('TransportSessionRuntime compact hijack hooks', () => {
  beforeEach(() => {
    resetTransportQueueStoreForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetTransportQueueStoreForTests();
  });

  it('aborts active turn and triggers compact hijack immediately on mid-turn status=compacting, blocking queued drain', async () => {
    const h = makeHarness();
    const hijackMock = vi.fn();
    h.runtime.canTriggerCompactHijack = () => true;
    h.runtime.onCompactHijack = hijackMock;
    await h.runtime.initialize({ cwd: '/tmp/proj' });

    void h.runtime.send('first task', 'cmd-1');
    await flush();
    void h.runtime.send('queued second task', 'cmd-2');
    await flush();
    expect(h.send).toHaveBeenCalledTimes(1);

    h.emitStatus({ status: 'compacting', label: 'Compacting...' });
    await flush();

    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(hijackMock).toHaveBeenCalledTimes(1);
    expect(hijackMock).toHaveBeenCalledWith({ reason: 'status' });
    // Even if completion fires right after, must not re-fire hijack or drain cmd-2 into old runtime
    h.emitComplete({ content: 'Compaction completed' });
    await flush();
    expect(hijackMock).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('triggers compact hijack on completion when provider reports compaction completion without status hook', async () => {
    const h = makeHarness();
    const hijackMock = vi.fn();
    h.runtime.canTriggerCompactHijack = () => true;
    h.runtime.onCompactHijack = hijackMock;
    await h.runtime.initialize({ cwd: '/tmp/proj' });

    void h.runtime.send('work', 'cmd-1');
    await flush();

    h.emitComplete({
      kind: 'system',
      role: 'system',
      content: 'Compacted',
      metadata: { event: 'thread/compacted' },
    });
    await flush();

    expect(hijackMock).toHaveBeenCalledTimes(1);
    expect(hijackMock).toHaveBeenCalledWith({ reason: 'completion' });
  });

  it('triggers compact hijack on watermark compaction and preserves the pending prompt', async () => {
    const h = makeHarness();
    const hijackMock = vi.fn();
    h.runtime.canTriggerCompactHijack = () => true;
    h.runtime.onCompactHijack = hijackMock;
    h.checkSessionCompaction.mockResolvedValueOnce(true);
    await h.runtime.initialize({ cwd: '/tmp/proj' });

    await h.runtime.send('please fix bug X', 'cmd-1');
    await flush();

    expect(h.send).not.toHaveBeenCalled();
    expect(hijackMock).toHaveBeenCalledTimes(1);
    expect(hijackMock).toHaveBeenCalledWith({
      reason: 'watermark',
      pendingPrompt: 'please fix bug X',
    });
  });

  it('exempts manual /compact and suppresses the immediate post-/compact watermark check', async () => {
    const h = makeHarness();
    const hijackMock = vi.fn();
    h.runtime.canTriggerCompactHijack = () => true;
    h.runtime.onCompactHijack = hijackMock;
    await h.runtime.initialize({ cwd: '/tmp/proj' });

    void h.runtime.send('/compact', 'cmd-compact');
    await flush();

    h.emitStatus({ status: 'compacting', label: 'Compacting...' });
    await flush();
    h.emitComplete({ content: 'Manual compact done' });
    await flush();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(hijackMock).not.toHaveBeenCalled();

    // Next turn watermark reflects manual /compact summary — suppressed once
    h.checkSessionCompaction.mockResolvedValueOnce(true);
    await h.runtime.send('after manual compact', 'cmd-after');
    await flush();
    expect(hijackMock).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalled();

    // Subsequent compaction watermark triggers normally
    h.emitComplete({ content: 'done' });
    await flush();
    h.checkSessionCompaction.mockResolvedValueOnce(true);
    await h.runtime.send('later message', 'cmd-later');
    await flush();
    expect(hijackMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger compact hijack for shared/participant turns or when canTriggerCompactHijack is false', async () => {
    const h = makeHarness();
    const hijackMock = vi.fn();
    h.runtime.canTriggerCompactHijack = () => true;
    h.runtime.onCompactHijack = hijackMock;
    await h.runtime.initialize({ cwd: '/tmp/proj' });

    void h.runtime.send('participant prompt', 'cmd-share', undefined, undefined, {
      sharedActor: {
        shareId: 'sh-1',
        actorUserId: 'guest-1',
        actorDisplayName: 'Guest',
        effectiveActorRole: 'participant',
        grantKind: 'tab',
        sharedServer: false,
      },
    } as never);
    await flush();

    h.emitStatus({ status: 'compacting', label: 'Compacting...' });
    await flush();
    h.emitComplete({
      kind: 'system',
      role: 'system',
      content: 'Compacted',
      metadata: { event: 'thread/compacted' },
    });
    await flush();

    expect(h.cancel).not.toHaveBeenCalled();
    expect(hijackMock).not.toHaveBeenCalled();

    // Also skipped when gate returns false
    h.runtime.canTriggerCompactHijack = () => false;
    void h.runtime.send('owner prompt', 'cmd-owner');
    await flush();
    h.emitStatus({ status: 'compacting', label: 'Compacting...' });
    await flush();
    expect(hijackMock).not.toHaveBeenCalled();
  });
});
