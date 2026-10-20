import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  beginDownloadTransfer,
  canRevealDownloadTransfer,
  completeDownloadTransfer,
  failDownloadTransfer,
  getDownloadTransfers,
  retryDownloadTransfer,
  revealDownloadTransfer,
  setDownloadTransferRetry,
  setDownloadTransferSavedFile,
} from '../src/download-transfer-store.js';
import {
  canRevealSavedDownload,
  revealSavedDownload,
  savedDownloadFileHandle,
} from '../src/download-file-actions.js';
import { createDownloadTransferWiring } from '../src/download-transfer-wiring.js';
import { FILE_DOWNLOAD_TRANSPORT_MODE } from '../src/direct-file-transfer.js';

type PickerGlobal = typeof globalThis & { showOpenFilePicker?: unknown };

function savedFile(getFile = vi.fn(async () => new File(['hello'], 'report.pdf', { type: 'application/pdf' }))) {
  return { getFile, createWritable: vi.fn() };
}

describe('download file actions', () => {
  beforeEach(() => {
    __resetDownloadTransfersForTests();
  });

  afterEach(() => {
    __resetDownloadTransfersForTests();
    delete (globalThis as PickerGlobal).showOpenFilePicker;
    vi.restoreAllMocks();
  });

  it('only treats a handle it can read back as a saved file', () => {
    expect(savedDownloadFileHandle(null)).toBeNull();
    expect(savedDownloadFileHandle({ createWritable: vi.fn() })).toBeNull();
    const handle = savedFile();
    expect(savedDownloadFileHandle(handle)).toBe(handle);
  });

  it('opens the file dialog in the folder the file was saved to', async () => {
    const handle = savedFile();
    expect(canRevealSavedDownload()).toBe(false);
    expect(revealSavedDownload(handle)).toBe(false);

    const picker = vi.fn(async () => { throw new DOMException('dismissed', 'AbortError'); });
    (globalThis as PickerGlobal).showOpenFilePicker = picker;

    expect(canRevealSavedDownload()).toBe(true);
    expect(revealSavedDownload(handle)).toBe(true);
    // Called synchronously, pointed at the saved file's own folder.
    expect(picker).toHaveBeenCalledWith({ startIn: handle });
    // A dismissed dialog is not an error.
    await Promise.resolve();
  });

  it('offers Show in folder only for a completed download that has a saved file', () => {
    const picker = vi.fn(async () => []);
    (globalThis as PickerGlobal).showOpenFilePicker = picker;
    const transfer = beginDownloadTransfer('report.pdf');

    // Not complete yet: attaching is refused.
    setDownloadTransferSavedFile(transfer.id, savedFile());
    expect(canRevealDownloadTransfer(transfer.id)).toBe(false);

    completeDownloadTransfer(transfer.id);
    expect(canRevealDownloadTransfer(transfer.id)).toBe(false);
    const handle = savedFile();
    setDownloadTransferSavedFile(transfer.id, handle);
    expect(canRevealDownloadTransfer(transfer.id)).toBe(true);
    expect(revealDownloadTransfer(transfer.id)).toBe(true);
    expect(picker).toHaveBeenCalledWith({ startIn: handle });

    // Without a file dialog API there is no button that could not do anything.
    delete (globalThis as PickerGlobal).showOpenFilePicker;
    expect(canRevealDownloadTransfer(transfer.id)).toBe(false);
  });

  it('drops the saved file when a download fails or is retried', async () => {
    (globalThis as PickerGlobal).showOpenFilePicker = vi.fn(async () => []);
    const failed = beginDownloadTransfer('failed.bin');
    completeDownloadTransfer(failed.id);
    setDownloadTransferSavedFile(failed.id, savedFile());
    // A completed row cannot be failed afterwards; a fresh failing one never
    // gets a file.
    const other = beginDownloadTransfer('other.bin');
    failDownloadTransfer(other.id);
    setDownloadTransferSavedFile(other.id, savedFile());
    expect(canRevealDownloadTransfer(other.id)).toBe(false);

    const retried = beginDownloadTransfer('retry.bin');
    let resolveRetry!: () => void;
    setDownloadTransferRetry(retried.id, () => new Promise<void>((resolve) => { resolveRetry = resolve; }));
    failDownloadTransfer(retried.id);
    const retry = retryDownloadTransfer(retried.id);
    expect(getDownloadTransfers().find((item) => item.id === retried.id)?.status).toBe(DOWNLOAD_TRANSFER_STATUS.PREPARING);
    expect(canRevealDownloadTransfer(retried.id)).toBe(false);
    resolveRetry();
    await retry;
  });

  it('wires completion to a saved file only when the page wrote the file itself', () => {
    (globalThis as PickerGlobal).showOpenFilePicker = vi.fn(async () => []);
    const destination = { handle: savedFile() };

    // Written through the save picker: the row can show it in its folder.
    const picked = beginDownloadTransfer('picked.pdf');
    const pickedWiring = createDownloadTransferWiring(picked.id);
    pickedWiring.onMode(FILE_DOWNLOAD_TRANSPORT_MODE.DIRECT);
    pickedWiring.complete(destination);
    expect(canRevealDownloadTransfer(picked.id)).toBe(true);

    // Handed to the browser's download manager: invisible to the page.
    const handedOff = beginDownloadTransfer('handed-off.pdf');
    const handedOffWiring = createDownloadTransferWiring(handedOff.id);
    handedOffWiring.onMode(FILE_DOWNLOAD_TRANSPORT_MODE.BROWSER);
    handedOffWiring.complete(destination);
    expect(getDownloadTransfers().find((item) => item.id === handedOff.id)?.status).toBe(DOWNLOAD_TRANSFER_STATUS.HANDED_OFF);
    expect(canRevealDownloadTransfer(handedOff.id)).toBe(false);

    // Still waiting for the mobile save sheet: not complete, no buttons.
    const pending = beginDownloadTransfer('pending.pdf');
    const pendingWiring = createDownloadTransferWiring(pending.id);
    pendingWiring.onSaveReady(async () => undefined);
    pendingWiring.complete(null);
    expect(getDownloadTransfers().find((item) => item.id === pending.id)?.status).toBe(DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE);
    expect(canRevealDownloadTransfer(pending.id)).toBe(false);
  });
});
