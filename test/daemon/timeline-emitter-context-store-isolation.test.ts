import { describe, expect, it, vi } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(() => new Promise<never>(() => {})));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: vi.fn(() => []),
    getLatest: vi.fn(() => null),
  },
}));

vi.mock('../../src/store/context-store-worker-client.js', () => ({
  getContextStoreClient: () => ({ run: runMock }),
}));

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(() => null),
}));

describe('TimelineEmitter context-store isolation', () => {
  it('does not wait for a stalled context-store RPC on the emit path', async () => {
    const { TimelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
    const emitter = new TimelineEmitter();

    const event = emitter.emit('session-isolation', 'usage.update', {
      inputTokens: 3,
      outputTokens: 2,
      model: 'test-model',
    });

    expect(event).not.toBeNull();
    expect(runMock).toHaveBeenCalledWith(
      'recordTurnUsage',
      [expect.objectContaining({ sessionName: 'session-isolation', inputTokens: 3, outputTokens: 2 })],
    );
  });
});

describe('TimelineEmitter.drainUsageWrites — bounded shutdown drain', () => {
  it('drains a pending usage write that completes before the shutdown budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let resolveWrite: (() => void) | undefined;
      runMock.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
      const { TimelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
      const emitter = new TimelineEmitter();
      emitter.emit('session-drain-ok', 'usage.update', { inputTokens: 1, outputTokens: 1, model: 'm' });

      const drainPromise = emitter.drainUsageWrites(3_000);
      // The write settles well inside the budget -- shutdown must not wait
      // out the full budget for a write that already finished.
      await vi.advanceTimersByTimeAsync(50);
      resolveWrite?.();
      const result = await drainPromise;
      expect(result).toEqual({ pendingAtStart: 1, abandoned: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a stalled write at the budget instead of blocking shutdown past it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runMock.mockImplementationOnce(() => new Promise<never>(() => { /* never settles */ }));
      const { TimelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
      const emitter = new TimelineEmitter();
      emitter.emit('session-drain-stall', 'usage.update', { inputTokens: 1, outputTokens: 1, model: 'm' });

      const drainPromise = emitter.drainUsageWrites(3_000);
      // Exactly the budget elapses -- drainUsageWrites must resolve here, not hang.
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await drainPromise;
      expect(result).toEqual({ pendingAtStart: 1, abandoned: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns immediately with nothing abandoned when no usage write is in flight', async () => {
    const { TimelineEmitter } = await import('../../src/daemon/timeline-emitter.js');
    const emitter = new TimelineEmitter();
    const result = await emitter.drainUsageWrites(3_000);
    expect(result).toEqual({ pendingAtStart: 0, abandoned: 0 });
  });
});
