import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  beginDownloadTransfer,
  cancelDownloadTransfer,
  completeDownloadTransfer,
  dismissDownloadTransfer,
  getDownloadTransfers,
  reportDownloadTransferProgress,
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
});
