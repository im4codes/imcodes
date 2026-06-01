import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerSessionSyncRetrier } from '../../src/daemon/worker-session-sync-retrier.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('worker session sync retrier', () => {
  it('keeps retrying a failed startup sync until it recovers', async () => {
    vi.useFakeTimers();
    const sync = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'EAI_AGAIN' })
      .mockResolvedValueOnce({ ok: true, syncedCount: 10 });
    const onRecovered = vi.fn();
    const retrier = createWorkerSessionSyncRetrier({
      sync,
      onRecovered,
      initialDelayMs: 100,
      maxDelayMs: 100,
      jitterRatio: 0,
    });

    retrier.start('startup_sync_failed');
    expect(retrier.isScheduled()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(retrier.isScheduled()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({ ok: true, syncedCount: 10 }));
    expect(retrier.isScheduled()).toBe(false);
  });

  it('stop cancels a pending retry', async () => {
    vi.useFakeTimers();
    const sync = vi.fn();
    const retrier = createWorkerSessionSyncRetrier({
      sync,
      initialDelayMs: 100,
      jitterRatio: 0,
    });

    retrier.start('startup_sync_failed');
    retrier.stop();

    await vi.advanceTimersByTimeAsync(100);
    expect(sync).not.toHaveBeenCalled();
    expect(retrier.isScheduled()).toBe(false);
  });

  it('keeps retrying retryable degraded outcomes even when ok is true for compatibility', async () => {
    vi.useFakeTimers();
    const sync = vi.fn()
      .mockResolvedValueOnce({ ok: true, retryable: true, reason: 'legacy_response' })
      .mockResolvedValueOnce({ ok: true, retryable: false, syncedCount: 2 });
    const onRecovered = vi.fn();
    const retrier = createWorkerSessionSyncRetrier({
      sync,
      onRecovered,
      initialDelayMs: 100,
      maxDelayMs: 100,
      jitterRatio: 0,
    });

    retrier.start('startup_sync_degraded');

    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(retrier.isScheduled()).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({ ok: true, retryable: false, syncedCount: 2 }));
    expect(retrier.isScheduled()).toBe(false);
  });
});
