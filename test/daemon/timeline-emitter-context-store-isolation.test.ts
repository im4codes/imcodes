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
