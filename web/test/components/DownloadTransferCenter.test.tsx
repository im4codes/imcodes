import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import {
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  beginDownloadTransfer,
  completeDownloadTransfer,
  failDownloadTransfer,
  getDownloadTransfers,
  reportDownloadTransferProgress,
  setDownloadTransferSave,
  setDownloadTransferRetry,
  updateDownloadTransfer,
} from '../../src/download-transfer-store.js';
import { DownloadTransferCenter } from '../../src/components/DownloadTransferCenter.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'downloads.transferred') return `${values?.transferred} / ${values?.total}`;
      if (key === 'downloads.speed') return `${values?.speed}/s`;
      return key;
    },
  }),
}));

describe('DownloadTransferCenter', () => {
  beforeEach(() => __resetDownloadTransfersForTests());
  afterEach(() => {
    cleanup();
    __resetDownloadTransfersForTests();
  });

  it('shows route, progress, speed, and cancels from the main-window list', () => {
    const transfer = beginDownloadTransfer('movie.mkv', 1_000);
    updateDownloadTransfer(transfer.id, DOWNLOAD_TRANSFER_ROUTE.DIRECT, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING, 1_000);
    reportDownloadTransferProgress(transfer.id, 512, 1_024, 1_250);
    render(<DownloadTransferCenter />);

    expect(screen.getByText('movie.mkv')).toBeTruthy();
    expect(screen.getByText('downloads.route.direct')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');

    fireEvent.click(screen.getByText('downloads.cancel'));
    expect(transfer.signal.aborted).toBe(true);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.CANCELED);
    expect(screen.getByText('downloads.status.canceled')).toBeTruthy();
  });

  it('middle-truncates a long filename while exposing the complete name on hover', () => {
    const name = '355e6ce9c3b8a7a757370f07c41dced1.zh-CN.subtitled.mp4';
    beginDownloadTransfer(name);
    render(<DownloadTransferCenter />);

    const filename = screen.getByTestId('download-transfer-name');
    expect(filename.getAttribute('title')).toBe(name);
    expect(filename.textContent).toBe(name);
    expect(filename.querySelector('.download-transfer-name-leading')).toBeTruthy();
    expect(filename.querySelector('.download-transfer-name-trailing')?.textContent).toBe('.zh-CN.subtitled.mp4');
  });

  it('keeps a completed row visible until it is dismissed', () => {
    const transfer = beginDownloadTransfer('done.zip');
    completeDownloadTransfer(transfer.id);
    render(<DownloadTransferCenter />);

    expect(screen.getByText('downloads.status.completed')).toBeTruthy();
    fireEvent.click(screen.getByText('downloads.dismiss'));
    expect(screen.queryByText('done.zip')).toBeNull();
  });

  it('retries a failed download in place and omits fake speed measurement text', async () => {
    const transfer = beginDownloadTransfer('retry.iso');
    const retry = vi.fn(async () => completeDownloadTransfer(transfer.id));
    setDownloadTransferRetry(transfer.id, retry);
    failDownloadTransfer(transfer.id);
    render(<DownloadTransferCenter />);

    expect(screen.queryByText('downloads.speed_calculating')).toBeNull();
    fireEvent.click(screen.getByText('downloads.retry'));

    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.COMPLETED);
    expect(screen.getByText('downloads.status.completed')).toBeTruthy();
  });

  it('offers a fresh user gesture when downloaded mobile bytes are waiting to be saved', async () => {
    const transfer = beginDownloadTransfer('mobile.docx');
    const save = vi.fn().mockResolvedValue(undefined);
    setDownloadTransferSave(transfer.id, save);
    render(<DownloadTransferCenter />);

    expect(screen.getByText('downloads.status.ready_to_save')).toBeTruthy();
    fireEvent.click(screen.getByText('downloads.save_share'));

    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.COMPLETED);
  });

  it('keeps the save/share action visible when the user dismisses the system sheet', async () => {
    const transfer = beginDownloadTransfer('mobile.docx');
    const save = vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError'));
    setDownloadTransferSave(transfer.id, save);
    render(<DownloadTransferCenter />);

    fireEvent.click(screen.getByText('downloads.save_share'));

    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE);
    expect(screen.getByText('downloads.save_share')).toBeTruthy();
  });
});
