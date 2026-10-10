import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  beginDownloadTransfer,
  canSaveDownloadTransfer,
  canRetryDownloadTransfer,
  canPauseDownloadTransfer,
  canResumeDownloadTransfer,
  cancelDownloadTransfer,
  completeDownloadTransfer,
  dismissDownloadTransfer,
  failDownloadTransfer,
  getDownloadTransfers,
  reportDownloadTransferProgress,
  retryDownloadTransfer,
  pauseDownloadTransfer,
  resumeDownloadTransfer,
  saveDownloadTransfer,
  setDownloadTransferSave,
  setDownloadTransferRetry,
  subscribeDownloadTransfers,
  updateDownloadTransfer,
} from '../src/download-transfer-store.js';

describe('download transfer store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    __resetDownloadTransfersForTests();
  });

  afterEach(() => {
    __resetDownloadTransfersForTests();
    vi.useRealTimers();
  });

  it('keeps one redacted row while route, sink-settled progress, and speed change', () => {
    const listener = vi.fn();
    const off = subscribeDownloadTransfers(listener);
    const transfer = beginDownloadTransfer('archive.bin', 1_000);
    updateDownloadTransfer(transfer.id, DOWNLOAD_TRANSFER_ROUTE.DIRECT, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING, 1_050);
    reportDownloadTransferProgress(transfer.id, 0, 1_000, 1_050);
    reportDownloadTransferProgress(transfer.id, 500, 1_000, 1_300);

    const [item] = getDownloadTransfers();
    expect(item).toMatchObject({
      id: transfer.id,
      name: 'archive.bin',
      route: DOWNLOAD_TRANSFER_ROUTE.DIRECT,
      status: DOWNLOAD_TRANSFER_STATUS.TRANSFERRING,
      loadedBytes: 500,
      totalBytes: 1_000,
    });
    expect(item.speedBps).toBeGreaterThan(0);
    expect(Object.keys(item).sort()).toEqual([
      'id', 'loadedBytes', 'name', 'route', 'speedBps', 'startedAt', 'status', 'totalBytes', 'updatedAt',
    ]);
    expect(listener).toHaveBeenCalled();
    off();
  });

  it('owns cancellation independently of the initiating component', () => {
    const transfer = beginDownloadTransfer('large.iso');
    const signal = transfer.signal;
    cancelDownloadTransfer(transfer.id);

    expect(signal.aborted).toBe(true);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.CANCELED);
  });

  it('retains terminal and browser-handoff rows until dismissal', () => {
    const transfer = beginDownloadTransfer('report.pdf');
    completeDownloadTransfer(transfer.id, true);
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      route: DOWNLOAD_TRANSFER_ROUTE.BROWSER,
      loadedBytes: 0,
      totalBytes: null,
    });

    cancelDownloadTransfer(transfer.id);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.HANDED_OFF);

    dismissDownloadTransfer(transfer.id);
    expect(getDownloadTransfers()).toEqual([]);
  });

  it('restarts a failed transfer with a fresh abort signal and the same row', async () => {
    const transfer = beginDownloadTransfer('retry.iso', 1_000);
    const firstSignal = transfer.signal;
    const retry = vi.fn(async (signal: AbortSignal) => {
      expect(signal).not.toBe(firstSignal);
      reportDownloadTransferProgress(transfer.id, 1_000, 1_000, 2_250);
      completeDownloadTransfer(transfer.id, false, 2_250);
    });
    setDownloadTransferRetry(transfer.id, retry);
    failDownloadTransfer(transfer.id, false, 1_500);

    expect(canRetryDownloadTransfer(transfer.id)).toBe(true);
    await retryDownloadTransfer(transfer.id, 2_000);

    expect(retry).toHaveBeenCalledOnce();
    expect(getDownloadTransfers()).toHaveLength(1);
    expect(getDownloadTransfers()[0]).toMatchObject({
      id: transfer.id,
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      loadedBytes: 1_000,
      totalBytes: 1_000,
      startedAt: 1_000,
    });
    expect(canRetryDownloadTransfer(transfer.id)).toBe(false);
  });

  it('pauses and resumes from the durable prefix without resetting progress', async () => {
    const transfer = beginDownloadTransfer('resume.iso', 1_000);
    const retry = vi.fn(async (_signal: AbortSignal, resumeFromBytes?: number) => {
      expect(resumeFromBytes).toBe(512);
      reportDownloadTransferProgress(transfer.id, 512, 1_024, 3_000);
      reportDownloadTransferProgress(transfer.id, 1_024, 1_024, 3_100);
      completeDownloadTransfer(transfer.id, false, 3_100);
    });
    setDownloadTransferRetry(transfer.id, retry);
    updateDownloadTransfer(transfer.id, DOWNLOAD_TRANSFER_ROUTE.DIRECT, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING, 1_050);
    reportDownloadTransferProgress(transfer.id, 512, 1_024, 1_200);

    expect(canPauseDownloadTransfer(transfer.id)).toBe(true);
    pauseDownloadTransfer(transfer.id, 1_300);
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.PAUSED,
      loadedBytes: 512,
      totalBytes: 1_024,
    });
    expect(canResumeDownloadTransfer(transfer.id)).toBe(true);

    await resumeDownloadTransfer(transfer.id, 2_000);
    expect(retry).toHaveBeenCalledOnce();
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      loadedBytes: 1_024,
      startedAt: 1_000,
    });
  });

  it('turns a silent transfer into a retryable failure after the stall bound', () => {
    const transfer = beginDownloadTransfer('stalled.iso', 1_000);
    setDownloadTransferRetry(transfer.id, vi.fn(async () => undefined));
    updateDownloadTransfer(transfer.id, DOWNLOAD_TRANSFER_ROUTE.HTTP, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING, 1_000);
    reportDownloadTransferProgress(transfer.id, 128, 1_000, 1_000);

    vi.advanceTimersByTime(30_500);
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.FAILED,
      loadedBytes: 128,
      totalBytes: 1_000,
    });
    expect(canRetryDownloadTransfer(transfer.id)).toBe(true);
  });

  it('retains downloaded bytes for an explicit save tap and completes only after it succeeds', async () => {
    const transfer = beginDownloadTransfer('mobile.docx', 1_000);
    reportDownloadTransferProgress(transfer.id, 64, 64, 1_100);
    const save = vi.fn()
      .mockRejectedValueOnce(new DOMException('gesture expired', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    setDownloadTransferSave(transfer.id, save, 1_200);

    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE,
      loadedBytes: 64,
      totalBytes: 64,
    });
    expect(canSaveDownloadTransfer(transfer.id)).toBe(true);

    await saveDownloadTransfer(transfer.id, 1_300);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE);
    expect(canSaveDownloadTransfer(transfer.id)).toBe(true);

    await saveDownloadTransfer(transfer.id, 1_400);
    expect(save).toHaveBeenCalledTimes(2);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.COMPLETED);
    expect(canSaveDownloadTransfer(transfer.id)).toBe(false);
  });
});
