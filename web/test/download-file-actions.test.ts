import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  beginDownloadTransfer,
  canOpenDownloadTransfer,
  canRevealDownloadTransfer,
  completeDownloadTransfer,
  failDownloadTransfer,
  getDownloadTransfers,
  openDownloadTransfer,
  retryDownloadTransfer,
  revealDownloadTransfer,
  setDownloadTransferRetry,
  setDownloadTransferSavedFile,
} from '../src/download-transfer-store.js';
import {
  canRevealSavedDownload,
  openSavedDownload,
  revealSavedDownload,
  savedDownloadFileHandle,
} from '../src/download-file-actions.js';
import { createDownloadTransferWiring } from '../src/download-transfer-wiring.js';
import { FILE_DOWNLOAD_TRANSPORT_MODE } from '../src/direct-file-transfer.js';

type PickerGlobal = typeof globalThis & { showOpenFilePicker?: unknown };

function savedFile(getFile = vi.fn(async () => new File(['hello'], 'report.pdf', { type: 'application/pdf' }))) {
  return { getFile, createWritable: vi.fn() };
}

function fakeTab() {
  return { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
}

describe('download file actions', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetDownloadTransfersForTests();
    createObjectURL = vi.fn(() => 'blob:report');
    revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
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

  it('opens the tab inside the click, before the file is read', async () => {
    let releaseFile!: (file: File) => void;
    const handle = savedFile(vi.fn(() => new Promise<File>((resolve) => { releaseFile = resolve; })));
    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);

    expect(openSavedDownload(handle)).toBe(true);
    // The tab exists already: waiting for getFile() first would cost the
    // user's gesture and the browser would block the tab.
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.location.href).toBe('');
    expect(tab.opener).toBeNull();

    releaseFile(new File(['hello'], 'report.pdf', { type: 'application/pdf' }));
    await vi.waitFor(() => expect(tab.location.href).toBe('blob:report'));
  });

  it('closes the blank tab when the saved file is gone, and reports a blocked tab', async () => {
    const tab = fakeTab();
    vi.spyOn(window, 'open').mockReturnValueOnce(tab as unknown as Window).mockReturnValueOnce(null);
    const missing = savedFile(vi.fn(async () => { throw new DOMException('moved', 'NotFoundError'); }));

    expect(openSavedDownload(missing)).toBe(true);
    await vi.waitFor(() => expect(tab.close).toHaveBeenCalled());

    expect(openSavedDownload(savedFile())).toBe(false);
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

  it('offers open/show only for a completed download that has a saved file', () => {
    (globalThis as PickerGlobal).showOpenFilePicker = vi.fn(async () => []);
    const transfer = beginDownloadTransfer('report.pdf');

    // Not complete yet: attaching is refused.
    setDownloadTransferSavedFile(transfer.id, savedFile());
    expect(canOpenDownloadTransfer(transfer.id)).toBe(false);

    completeDownloadTransfer(transfer.id);
    expect(canOpenDownloadTransfer(transfer.id)).toBe(false);
    setDownloadTransferSavedFile(transfer.id, savedFile());
    expect(canOpenDownloadTransfer(transfer.id)).toBe(true);
    expect(canRevealDownloadTransfer(transfer.id)).toBe(true);

    const tab = fakeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    expect(openDownloadTransfer(transfer.id)).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(revealDownloadTransfer(transfer.id)).toBe(true);

    // Without a file dialog API the row still opens the file, but offers no
    // folder button that could not do anything.
    delete (globalThis as PickerGlobal).showOpenFilePicker;
    expect(canOpenDownloadTransfer(transfer.id)).toBe(true);
    expect(canRevealDownloadTransfer(transfer.id)).toBe(false);
  });

  it('drops the saved file when a download fails or is retried', async () => {
    const failed = beginDownloadTransfer('failed.bin');
    completeDownloadTransfer(failed.id);
    setDownloadTransferSavedFile(failed.id, savedFile());
    // A completed row cannot be failed afterwards; a fresh failing one never
    // gets a file.
    const other = beginDownloadTransfer('other.bin');
    failDownloadTransfer(other.id);
    setDownloadTransferSavedFile(other.id, savedFile());
    expect(canOpenDownloadTransfer(other.id)).toBe(false);

    const retried = beginDownloadTransfer('retry.bin');
    let resolveRetry!: () => void;
    setDownloadTransferRetry(retried.id, () => new Promise<void>((resolve) => { resolveRetry = resolve; }));
    failDownloadTransfer(retried.id);
    const retry = retryDownloadTransfer(retried.id);
    expect(getDownloadTransfers().find((item) => item.id === retried.id)?.status).toBe(DOWNLOAD_TRANSFER_STATUS.PREPARING);
    expect(canOpenDownloadTransfer(retried.id)).toBe(false);
    resolveRetry();
    await retry;
  });

  it('wires completion to a saved file only when the page wrote the file itself', () => {
    const destination = { handle: savedFile() };

    // Written through the save picker: the row can open it.
    const picked = beginDownloadTransfer('picked.pdf');
    const pickedWiring = createDownloadTransferWiring(picked.id);
    pickedWiring.onMode(FILE_DOWNLOAD_TRANSPORT_MODE.DIRECT);
    pickedWiring.complete(destination);
    expect(canOpenDownloadTransfer(picked.id)).toBe(true);

    // Handed to the browser's download manager: invisible to the page.
    const handedOff = beginDownloadTransfer('handed-off.pdf');
    const handedOffWiring = createDownloadTransferWiring(handedOff.id);
    handedOffWiring.onMode(FILE_DOWNLOAD_TRANSPORT_MODE.BROWSER);
    handedOffWiring.complete(destination);
    expect(getDownloadTransfers().find((item) => item.id === handedOff.id)?.status).toBe(DOWNLOAD_TRANSFER_STATUS.HANDED_OFF);
    expect(canOpenDownloadTransfer(handedOff.id)).toBe(false);

    // Still waiting for the mobile save sheet: not complete, no buttons.
    const pending = beginDownloadTransfer('pending.pdf');
    const pendingWiring = createDownloadTransferWiring(pending.id);
    pendingWiring.onSaveReady(async () => undefined);
    pendingWiring.complete(null);
    expect(getDownloadTransfers().find((item) => item.id === pending.id)?.status).toBe(DOWNLOAD_TRANSFER_STATUS.READY_TO_SAVE);
    expect(canOpenDownloadTransfer(pending.id)).toBe(false);
  });
});
