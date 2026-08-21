import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import {
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  beginDownloadTransfer,
  completeDownloadTransfer,
  getDownloadTransfers,
  reportDownloadTransferProgress,
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

  it('keeps a completed row visible until it is dismissed', () => {
    const transfer = beginDownloadTransfer('done.zip');
    completeDownloadTransfer(transfer.id);
    render(<DownloadTransferCenter />);

    expect(screen.getByText('downloads.status.completed')).toBeTruthy();
    fireEvent.click(screen.getByText('downloads.dismiss'));
    expect(screen.queryByText('done.zip')).toBeNull();
  });
});
