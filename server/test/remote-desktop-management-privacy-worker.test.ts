import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  REMOTE_DESKTOP_PRIVACY_SWEEP_BATCH,
  REMOTE_DESKTOP_PRIVACY_SWEEP_MS,
  RemoteDesktopManagementPrivacyWorker,
  type RemoteDesktopPrivacyClock,
  type RemoteDesktopPrivacySweep,
} from '../src/services/remote-desktop-management-privacy-worker.js';

const db = {} as Database;

describe('remote desktop management privacy worker', () => {
  afterEach(() => vi.useRealTimers());

  it('starts immediately, polls within the bounded interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const sweep = vi.fn<RemoteDesktopPrivacySweep>()
      .mockResolvedValue({ recovered: [] });
    const clock = vi.fn<RemoteDesktopPrivacyClock>().mockResolvedValue(1_000);
    const worker = new RemoteDesktopManagementPrivacyWorker(db, undefined, clock, sweep);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledWith(db, { now: 1_000, limit: REMOTE_DESKTOP_PRIVACY_SWEEP_BATCH });
    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_PRIVACY_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_PRIVACY_SWEEP_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('does not overlap a slow sweep and retries after failure without reopening state', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: { recovered: string[] }) => void) | undefined;
    const first = new Promise<{ recovered: string[] }>((resolve) => { resolveFirst = resolve; });
    const sweep = vi.fn<RemoteDesktopPrivacySweep>()
      .mockReturnValueOnce(first)
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ recovered: ['host-1'] });
    const onError = vi.fn();
    const clock = vi.fn<RemoteDesktopPrivacyClock>().mockResolvedValue(2_000);
    const worker = new RemoteDesktopManagementPrivacyWorker(db, onError, clock, sweep);
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_PRIVACY_SWEEP_MS * 2);
    expect(sweep).toHaveBeenCalledTimes(1);
    resolveFirst?.({ recovered: [] });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_PRIVACY_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_PRIVACY_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(3);
    await worker.stop();
  });

  it('waits for an in-flight sweep before shutdown returns', async () => {
    vi.useFakeTimers();
    let resolveSweep: ((value: { recovered: string[] }) => void) | undefined;
    const sweepResult = new Promise<{ recovered: string[] }>((resolve) => { resolveSweep = resolve; });
    const sweep = vi.fn<RemoteDesktopPrivacySweep>().mockReturnValue(sweepResult);
    const clock = vi.fn<RemoteDesktopPrivacyClock>().mockResolvedValue(3_000);
    const worker = new RemoteDesktopManagementPrivacyWorker(db, undefined, clock, sweep);

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveSweep?.({ recovered: [] });
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_PRIVACY_SWEEP_MS * 2);
    expect(sweep).toHaveBeenCalledOnce();
  });

  it('rejects a non-authoritative local clock value before touching persistence', async () => {
    const sweep = vi.fn<RemoteDesktopPrivacySweep>();
    const clock = vi.fn<RemoteDesktopPrivacyClock>().mockResolvedValue(Number.NaN);
    const worker = new RemoteDesktopManagementPrivacyWorker(db, undefined, clock, sweep);
    await expect(worker.runOnce()).rejects.toThrow('invalid_privacy_sweep_clock');
    expect(sweep).not.toHaveBeenCalled();
  });
});
