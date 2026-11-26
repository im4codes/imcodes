/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_FILE_TRANSFER_ERROR } from '@shared/direct-file-transfer.js';
import {
  __resetDownloadTransfersForTests,
  beginDownloadCommit,
  beginDownloadTransfer,
  canCancelDownloadTransfer,
  canPauseDownloadTransfer,
  canRetryDownloadTransfer,
  canRevealDownloadTransfer,
  cancelDownloadTransfer,
  completeDownloadTransfer,
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  getDownloadTransfers,
  pauseDownloadTransfer,
  reportDownloadTransferProgress,
  resumeDownloadTransfer,
  retryDownloadTransfer,
  revealDownloadTransfer,
  setDownloadTransferRetry,
  setDownloadTransferSavedFile,
  updateDownloadTransfer,
} from '../src/download-transfer-store.js';
import {
  canRevealSavedDownload,
  revealSavedDownload,
  savedDownloadFileHandle,
} from '../src/download-file-actions.js';
import {
  isPcAppDownloadDestination,
  selectPreviewDownloadDestination,
} from '../src/download-destination.js';

const nativeState = vi.hoisted(() => ({ native: false }));

vi.mock('../src/native.js', () => ({
  isNative: () => nativeState.native,
}));

function clearPcAppBridge() {
  delete (globalThis as { __IMCODES_PC_APP__?: unknown }).__IMCODES_PC_APP__;
  delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  delete (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker;
}

describe('PC App download destination bridge', () => {
  beforeEach(() => {
    nativeState.native = false;
    clearPcAppBridge();
    __resetDownloadTransfersForTests();
  });

  afterEach(() => {
    nativeState.native = false;
    clearPcAppBridge();
    __resetDownloadTransfersForTests();
    vi.restoreAllMocks();
  });

  it('prefers PC App downloads bridge, streams chunks (splitting >16 MiB), supports seek/truncate/abort, and reveals natively', async () => {
    const writtenChunks: Uint8Array[] = [];
    const downloads = {
      pickSaveFile: vi.fn(async () => ({
        canceled: false as const,
        handleId: 'h-1',
        name: '演示视频.mp4',
      })),
      openWriter: vi.fn(async () => ({ writerId: 'w-1' })),
      writeChunk: vi.fn(async ({ chunk }: { writerId: string; chunk: Uint8Array | ArrayBuffer }) => {
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk);
        writtenChunks.push(bytes);
        return { bytesWritten: bytes.byteLength, position: bytes.byteLength };
      }),
      seekWriter: vi.fn(async () => undefined),
      truncateWriter: vi.fn(async () => undefined),
      closeWriter: vi.fn(async () => undefined),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 4_000_000_000, name: '演示视频.mp4' })),
      revealFile: vi.fn(async () => true),
    };

    const showSaveFilePicker = vi.fn();
    (globalThis as Record<string, unknown>).showSaveFilePicker = showSaveFilePicker;
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      downloads,
    };

    const dest = await selectPreviewDownloadDestination('演示视频.mp4');
    expect(dest).not.toBeNull();
    expect(isPcAppDownloadDestination(dest)).toBe(true);
    expect(downloads.pickSaveFile).toHaveBeenCalledWith({ suggestedName: '演示视频.mp4' });
    expect(showSaveFilePicker).not.toHaveBeenCalled();

    // Multi-GB size returned in O(1) via getFileSize without allocating buffers
    const fileMeta = await dest!.handle.getFile!();
    expect(fileMeta.name).toBe('演示视频.mp4');
    expect(fileMeta.size).toBe(4_000_000_000);

    // Chunks > 16 MiB are automatically split
    const writer = await dest!.handle.createWritable({ keepExistingData: true });
    expect(downloads.openWriter).toHaveBeenCalledWith({ handleId: 'h-1', keepExistingData: true });

    await writer.seek?.(100);
    expect(downloads.seekWriter).toHaveBeenCalledWith({ writerId: 'w-1', position: 100 });

    const largeChunk = new Uint8Array(17 * 1024 * 1024);
    largeChunk[0] = 7;
    largeChunk[largeChunk.length - 1] = 9;
    await writer.write(largeChunk);
    expect(downloads.writeChunk).toHaveBeenCalledTimes(2);
    expect(writtenChunks[0]!.byteLength).toBe(16 * 1024 * 1024);
    expect(writtenChunks[1]!.byteLength).toBe(1 * 1024 * 1024);

    await writer.truncate?.(1024);
    expect(downloads.truncateWriter).toHaveBeenCalledWith({ writerId: 'w-1', size: 1024 });

    await writer.close();
    expect(downloads.closeWriter).toHaveBeenCalledWith({ writerId: 'w-1' });
    // Abort after close is a safe no-op
    await writer.abort();
    expect(downloads.abortWriter).not.toHaveBeenCalled();

    // Native reveal flows through DownloadTransferCenter without showOpenFilePicker
    const transfer = beginDownloadTransfer('演示视频.mp4');
    completeDownloadTransfer(transfer.id, false);
    const saved = savedDownloadFileHandle(dest!.handle);
    expect(saved).not.toBeNull();
    setDownloadTransferSavedFile(transfer.id, saved);
    expect(canRevealSavedDownload()).toBe(true);
    expect(canRevealDownloadTransfer(transfer.id)).toBe(true);
    expect(revealDownloadTransfer(transfer.id)).toBe(true);
    expect(downloads.revealFile).toHaveBeenCalledWith({ handleId: 'h-1' });
  });

  it('throws CANCELED when the PC App save dialog is canceled without falling back', async () => {
    const downloads = {
      pickSaveFile: vi.fn(async () => ({ canceled: true as const })),
      openWriter: vi.fn(),
      writeChunk: vi.fn(),
      closeWriter: vi.fn(),
      abortWriter: vi.fn(),
      getFileSize: vi.fn(),
    };
    (globalThis as Record<string, unknown>).showSaveFilePicker = vi.fn();
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      isElectron: true,
      downloads,
    };

    await expect(selectPreviewDownloadDestination('movie.mp4')).rejects.toMatchObject({
      code: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
    });
  });

  it('maps ENOSPC errors from PC App IPC into QuotaExceededError and idempotently aborts unfinished writers', async () => {
    const downloads = {
      pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-2', name: 'disk.bin' })),
      openWriter: vi.fn(async () => ({ writerId: 'w-2' })),
      writeChunk: vi.fn(async () => {
        throw new Error("Error invoking remote method 'imcodes:pc-download:write-chunk': QuotaExceededError (ENOSPC): no space left on device");
      }),
      closeWriter: vi.fn(),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 0, name: 'disk.bin' })),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      isElectron: true,
      downloads,
    };

    const dest = await selectPreviewDownloadDestination('disk.bin');
    const writer = await dest!.handle.createWritable();
    await expect(writer.write(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });

    await writer.abort();
    await writer.abort();
    expect(downloads.abortWriter).toHaveBeenCalledTimes(1);
    expect(downloads.abortWriter).toHaveBeenCalledWith({ writerId: 'w-2' });
  });

  it('skips showSaveFilePicker in older/partial Electron PC App runtimes and preserves browser/Capacitor behavior', async () => {
    const browserHandle = {
      createWritable: vi.fn(),
      getFile: vi.fn(async () => new File(['x'], 'browser.txt')),
    };
    const showSaveFilePicker = vi.fn(async () => browserHandle);
    (globalThis as Record<string, unknown>).showSaveFilePicker = showSaveFilePicker;

    // Older PC App (has __IMCODES_PC_APP__ without .downloads) returns null without calling showSaveFilePicker
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = { isElectron: true };
    expect(await selectPreviewDownloadDestination('old-pc-app.txt')).toBeNull();
    expect(showSaveFilePicker).not.toHaveBeenCalled();

    // Electron User-Agent without preload bridge also returns null without calling showSaveFilePicker
    delete (globalThis as { __IMCODES_PC_APP__?: unknown }).__IMCODES_PC_APP__;
    const uaSpy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Electron/35.0.0 Chrome/134.0.0.0');
    expect(await selectPreviewDownloadDestination('electron-ua.txt')).toBeNull();
    expect(showSaveFilePicker).not.toHaveBeenCalled();

    // Non-Electron standard desktop browser still uses showSaveFilePicker and is NOT tagged as PC App destination
    uaSpy.mockReturnValue('Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36');
    const dest = await selectPreviewDownloadDestination('browser.txt');
    expect(dest).toEqual({ handle: browserHandle });
    expect(dest?.handle).toBe(browserHandle);
    expect(isPcAppDownloadDestination(dest)).toBe(false);
    expect(showSaveFilePicker).toHaveBeenCalledOnce();

    // Mobile Capacitor stays null regardless of bridge
    nativeState.native = true;
    expect(await selectPreviewDownloadDestination('mobile.txt')).toBeNull();
  });

  it('never falls back to anchor download in downloadCloudDocApi when PC App openWriter or closeWriter rejects', async () => {
    const openDownloads = {
      pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-open-err', name: 'open.docx' })),
      openWriter: vi.fn(async () => {
        throw new DOMException('open denied', 'NotAllowedError');
      }),
      writeChunk: vi.fn(),
      closeWriter: vi.fn(),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 0, name: 'open.docx' })),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      downloads: openDownloads,
    };

    const anchorClicks: string[] = [];
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = origCreateElement(tagName, options);
      if (tagName.toLowerCase() === 'a') {
        vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => {
          anchorClicks.push((el as HTMLAnchorElement).href || (el as HTMLAnchorElement).download || 'anchor');
        });
      }
      return el;
    }) as typeof document.createElement);

    const api = await import('../src/api.js');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new TextEncoder().encode('ABC'), { status: 200, headers: { 'content-length': '3' } }),
    );
    await expect(api.downloadCloudDocApi('doc_open_fail', 'open.docx')).rejects.toThrow('open denied');
    expect(anchorClicks).toEqual([]);

    // closeWriter refusal in PC App aborts the writer and fails without calling anchor.click() / mintCloudDocDownloadUrl
    const closeDownloads = {
      pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-close-err', name: 'close.docx' })),
      openWriter: vi.fn(async () => ({ writerId: 'w-close-err' })),
      writeChunk: vi.fn(async ({ chunk }: { chunk: Uint8Array | ArrayBuffer }) => ({
        bytesWritten: chunk.byteLength,
        position: chunk.byteLength,
      })),
      closeWriter: vi.fn(async () => {
        throw new DOMException('close denied', 'NotAllowedError');
      }),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 0, name: 'close.docx' })),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      downloads: closeDownloads,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new TextEncoder().encode('XYZ'), { status: 200, headers: { 'content-length': '3' } }),
    );
    await expect(api.downloadCloudDocApi('doc_close_fail', 'close.docx')).rejects.toThrow('close denied');
    expect(closeDownloads.closeWriter).toHaveBeenCalledWith({ writerId: 'w-close-err' });
    expect(closeDownloads.abortWriter).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(anchorClicks).toEqual([]);

    // Standard non-Electron browser destination STILL falls back cleanly on writer.close() FSA refusal
    delete (globalThis as { __IMCODES_PC_APP__?: unknown }).__IMCODES_PC_APP__;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/134.0.0.0');
    const browserWriter = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        throw new DOMException('blocked .svg', 'NotAllowedError');
      }),
      abort: vi.fn(async () => undefined),
    };
    (globalThis as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => ({
      createWritable: vi.fn(async () => browserWriter),
      getFile: vi.fn(async () => new File([], 'browser.svg')),
    }));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new TextEncoder().encode('<svg/>'), { status: 200, headers: { 'content-length': '6' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ticket: 'tkt-browser',
        downloadPath: '/api/cloud-docs/doc_browser_close_refusal/download?ticket=tkt-browser',
        expiresInSeconds: 60,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    await api.downloadCloudDocApi('doc_browser_close_refusal', 'browser.svg');
    expect(browserWriter.abort).toHaveBeenCalledOnce();
    expect(anchorClicks).toHaveLength(1);
    expect(anchorClicks[0]).toContain('/api/cloud-docs/doc_browser_close_refusal/download?ticket=tkt-browser');
  });

  it('streams downloadCloudDocApi through PC App bridge end-to-end without browser fallback', async () => {
    const chunks: Uint8Array[] = [];
    const downloads = {
      pickSaveFile: vi.fn(async () => ({
        canceled: false as const,
        handleId: 'h-cdoc',
        name: 'report.docx',
      })),
      openWriter: vi.fn(async () => ({ writerId: 'w-cdoc' })),
      writeChunk: vi.fn(async ({ chunk }: { chunk: Uint8Array | ArrayBuffer }) => {
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk);
        chunks.push(bytes);
        return { bytesWritten: bytes.byteLength, position: bytes.byteLength };
      }),
      closeWriter: vi.fn(async () => undefined),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 5, name: 'report.docx' })),
      revealFile: vi.fn(async () => true),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      downloads,
    };

    const payload = new TextEncoder().encode('HELLO');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(payload, { status: 200, headers: { 'content-length': '5' } }),
    );

    const api = await import('../src/api.js');
    await api.downloadCloudDocApi('doc_123', 'report.docx');

    expect(downloads.pickSaveFile).toHaveBeenCalledWith({ suggestedName: 'report.docx' });
    expect(downloads.openWriter).toHaveBeenCalledWith({ handleId: 'h-cdoc', keepExistingData: false });
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')).toBe('HELLO');
    expect(downloads.closeWriter).toHaveBeenCalledWith({ writerId: 'w-cdoc' });

    const rows = getDownloadTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(DOWNLOAD_TRANSFER_STATUS.COMPLETED);
    expect(rows[0]!.route).not.toBe('browser');
    expect(canRevealDownloadTransfer(rows[0]!.id)).toBe(true);
    expect(revealDownloadTransfer(rows[0]!.id)).toBe(true);
    expect(downloads.revealFile).toHaveBeenCalledWith({ handleId: 'h-cdoc' });
  });

  it('streams downloadAttachmentToCenter through PC App bridge, tracks progress, and reveals natively', async () => {
    const chunks: Uint8Array[] = [];
    const downloads = {
      pickSaveFile: vi.fn(async () => ({
        canceled: false as const,
        handleId: 'h-att-dl',
        name: 'trace.zip',
      })),
      openWriter: vi.fn(async () => ({ writerId: 'w-att-dl' })),
      writeChunk: vi.fn(async ({ chunk }: { chunk: Uint8Array | ArrayBuffer }) => {
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk);
        chunks.push(bytes.slice());
        return { bytesWritten: bytes.byteLength, position: bytes.byteLength };
      }),
      closeWriter: vi.fn(async () => undefined),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 10, name: 'trace.zip' })),
      revealFile: vi.fn(async () => true),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads,
    };

    const part1 = new Uint8Array([1, 2, 3, 4]);
    const part2 = new Uint8Array([5, 6, 7, 8, 9, 10]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(part1);
        controller.enqueue(part2);
        controller.close();
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { 'content-length': '10' } }),
    );
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const api = await import('../src/api.js');
    api.configure('https://hub.example');
    await api.downloadAttachmentToCenter('srv-1', 'att-zip', 'trace.zip', 'deck_main');

    expect(downloads.pickSaveFile).toHaveBeenCalledWith({ suggestedName: 'trace.zip' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/api/server/srv-1/uploads/att-zip/download?sessionName=deck_main');
    expect(downloads.openWriter).toHaveBeenCalledWith({ handleId: 'h-att-dl', keepExistingData: false });
    expect(downloads.closeWriter).toHaveBeenCalledWith({ writerId: 'w-att-dl' });
    expect(anchorClick).not.toHaveBeenCalled();
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c)))).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    const rows = getDownloadTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'trace.zip',
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      route: DOWNLOAD_TRANSFER_ROUTE.HTTP,
      loadedBytes: 10,
      totalBytes: 10,
    });
    expect(canRevealDownloadTransfer(rows[0]!.id)).toBe(true);
    expect(revealDownloadTransfer(rows[0]!.id)).toBe(true);
    expect(downloads.revealFile).toHaveBeenCalledWith({ handleId: 'h-att-dl' });
  });

  it('aborts attachment download cleanly on cancel (pre-picker or mid-stream), propagates disk full, and falls back on refusal', async () => {
    const api = await import('../src/api.js');
    api.configure('https://hub.example');

    // 1. Save picker canceled -> no fetch, no transfer row
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads: {
        pickSaveFile: vi.fn(async () => ({ canceled: true as const })),
        openWriter: vi.fn(),
        writeChunk: vi.fn(),
        closeWriter: vi.fn(),
        abortWriter: vi.fn(),
        getFileSize: vi.fn(),
      },
    };
    await expect(api.downloadAttachmentToCenter('srv-1', 'att-c', 'c.bin')).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getDownloadTransfers()).toEqual([]);

    // 2. Disk-full QuotaExceededError -> abortWriter + FAILED status, never falls back to anchor
    __resetDownloadTransfersForTests();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const abortFull = vi.fn(async () => undefined);
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads: {
        pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-full', name: 'full.bin' })),
        openWriter: vi.fn(async () => ({ writerId: 'w-full' })),
        writeChunk: vi.fn(async () => {
          throw new Error('ENOSPC: no space left on device');
        }),
        closeWriter: vi.fn(),
        abortWriter: abortFull,
        getFileSize: vi.fn(),
      },
    };
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } }));
    await expect(api.downloadAttachmentToCenter('srv-1', 'att-full', 'full.bin')).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    expect(abortFull).toHaveBeenCalledWith({ writerId: 'w-full' });
    expect(anchorClick).not.toHaveBeenCalled();
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);

    // 3. Mid-stream cancel -> abortWriter + CANCELED status
    __resetDownloadTransfersForTests();
    const abortCancel = vi.fn(async () => undefined);
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      downloads: {
        pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-mid', name: 'mid.bin' })),
        openWriter: vi.fn(async () => ({ writerId: 'w-mid' })),
        writeChunk: vi.fn(async () => ({ bytesWritten: 1, position: 1 })),
        closeWriter: vi.fn(),
        abortWriter: abortCancel,
        getFileSize: vi.fn(),
      },
    };
    fetchSpy.mockImplementationOnce(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '100' }),
        body: {
          getReader: () => ({
            read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              signal?.addEventListener('abort', () => resolve({ done: true }), { once: true });
            }),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(),
          }),
        },
      } as unknown as Response;
    });
    const pending = api.downloadAttachmentToCenter('srv-1', 'att-mid', 'mid.bin');
    await vi.waitFor(() => expect(getDownloadTransfers()).toHaveLength(1));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    cancelDownloadTransfer(getDownloadTransfers()[0]!.id);
    await expect(pending).resolves.toBeUndefined();
    expect(abortCancel).toHaveBeenCalledWith({ writerId: 'w-mid' });
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.CANCELED);

    // 4. File System Access refusal in standard browser -> falls back to browser anchor + HANDED_OFF
    __resetDownloadTransfersForTests();
    clearPcAppBridge();
    (globalThis as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => ({
      createWritable: vi.fn(async () => {
        throw new DOMException('Restricted type', 'SecurityError');
      }),
    }));
    await api.downloadAttachmentToCenter('srv-1', 'att-refuse', 'diagram.svg');
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(getDownloadTransfers()[0]).toMatchObject({
      name: 'diagram.svg',
      status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      route: DOWNLOAD_TRANSFER_ROUTE.BROWSER,
    });

    // 4b. PC App openWriter refusal NEVER falls back to browser anchor (prevents double save dialog)
    __resetDownloadTransfersForTests();
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads: {
        pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-pc-refuse', name: 'doc.pdf' })),
        openWriter: vi.fn(async () => {
          throw new DOMException('open denied', 'NotAllowedError');
        }),
        writeChunk: vi.fn(),
        closeWriter: vi.fn(),
        abortWriter: vi.fn(),
        getFileSize: vi.fn(),
      },
    };
    await expect(api.downloadAttachmentToCenter('srv-1', 'att-pc-refuse', 'doc.pdf')).rejects.toThrow('open denied');
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);

    // 5. Non-picker browser -> falls back to browser anchor + HANDED_OFF
    __resetDownloadTransfersForTests();
    clearPcAppBridge();
    await api.downloadAttachmentToCenter('srv-1', 'att-nopicker', 'notes.txt');
    expect(anchorClick).toHaveBeenCalledTimes(2);
    expect(getDownloadTransfers()[0]).toMatchObject({
      name: 'notes.txt',
      status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      route: DOWNLOAD_TRANSFER_ROUTE.BROWSER,
    });
  });

  it('[P0-1] locks out pause for restart-only transfers, disables cancel/pause during delayed writer.close(), and serializes pausable resume behind cleanup', async () => {
    const api = await import('../src/api.js');
    api.configure('https://hub.example');

    // A. downloadAttachmentToCenter registers failure-only retry (not pausable) and protects close() commit window
    let resolveClose!: () => void;
    let resolveFirstAttemptGate!: () => void;
    const downloads = {
      pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-commit', name: 'commit.bin' })),
      openWriter: vi.fn(async () => ({ writerId: 'w-commit' })),
      writeChunk: vi.fn(async () => ({ bytesWritten: 4, position: 4 })),
      closeWriter: vi.fn(() => new Promise<void>((resolve) => {
        resolveClose = resolve;
      })),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 4, name: 'commit.bin' })),
      revealFile: vi.fn(async () => true),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads,
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await new Promise<void>((resolve) => { resolveFirstAttemptGate = resolve; });
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      }), { status: 200, headers: { 'content-length': '4' } }),
    );

    const pending = api.downloadAttachmentToCenter('srv-1', 'att-commit', 'commit.bin');
    await vi.waitFor(() => expect(getDownloadTransfers()).toHaveLength(1));
    const transferId = getDownloadTransfers()[0]!.id;

    // Restart-only path must NOT offer pause while active
    expect(canPauseDownloadTransfer(transferId)).toBe(false);
    pauseDownloadTransfer(transferId);
    expect(getDownloadTransfers()[0]?.status).not.toBe(DOWNLOAD_TRANSFER_STATUS.PAUSED);

    resolveFirstAttemptGate();
    await vi.waitFor(() => expect(typeof resolveClose).toBe('function'));

    // During writer.close() commit window, pause & cancel are both disabled and ignored
    expect(canPauseDownloadTransfer(transferId)).toBe(false);
    expect(canCancelDownloadTransfer(transferId)).toBe(false);
    cancelDownloadTransfer(transferId);
    expect(getDownloadTransfers()[0]?.status).not.toBe(DOWNLOAD_TRANSFER_STATUS.CANCELED);

    resolveClose();
    await pending;
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.COMPLETED);
    expect(canRevealDownloadTransfer(transferId)).toBe(true);

    // B. Pausable delayed writer in writeDownloadDestinationWithFallback: pause keeps PAUSED, resume waits for abort() cleanup, stale signal is ignored
    __resetDownloadTransfersForTests();
    const { writeDownloadDestinationWithFallback } = await import('../src/download-destination-write.js');
    const order: string[] = [];
    let resolveDelayedAbort!: () => void;
    let rejectDelayedWrite!: (err: unknown) => void;
    let attemptIndex = 0;

    const delayedDestination = {
      handle: {
        async createWritable() {
          const idx = ++attemptIndex;
          order.push(`open-${idx}`);
          return {
            write: () => {
              if (idx === 1) {
                order.push('write-1');
                return new Promise<void>((_res, rej) => { rejectDelayedWrite = rej; });
              }
              order.push('write-2');
              return Promise.resolve();
            },
            close: async () => { order.push(`close-${idx}`); },
            abort: () => {
              order.push(`abort-${idx}-start`);
              return new Promise<void>((res) => {
                resolveDelayedAbort = () => {
                  order.push(`abort-${idx}-end`);
                  res();
                };
              });
            },
          };
        },
        getFile: async () => new File(['ok'], 'pausable.bin'),
        reveal: vi.fn(async () => true),
      },
    };

    const tx = beginDownloadTransfer('pausable.bin');
    const runPausable = async (sig: AbortSignal) => {
      updateDownloadTransfer(tx.id, DOWNLOAD_TRANSFER_ROUTE.HTTP, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING, Date.now(), sig);
      await writeDownloadDestinationWithFallback({
        transferId: tx.id,
        destination: delayedDestination,
        signal: sig,
        writeTo: async (writer) => {
          sig.addEventListener('abort', () => {
            rejectDelayedWrite?.(new DOMException('paused', 'AbortError'));
          }, { once: true });
          await writer.write(new Uint8Array([9, 8]));
          reportDownloadTransferProgress(tx.id, 2, 2, Date.now(), sig);
          return !sig.aborted;
        },
        fallbackToBrowser: async () => undefined,
      });
    };
    setDownloadTransferRetry(tx.id, runPausable, { pausable: true });

    const attempt1Promise = (await import('../src/download-transfer-store.js')).trackDownloadTransferAttempt(
      tx.id,
      tx.signal,
      runPausable(tx.signal),
    );
    await vi.waitFor(() => expect(order).toContain('write-1'));
    expect(canPauseDownloadTransfer(tx.id)).toBe(true);
    pauseDownloadTransfer(tx.id);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.PAUSED);

    // Resume BEFORE attempt 1's abort() cleanup completes -> attempt 2 must wait until abort-1-end!
    const resumePromise = resumeDownloadTransfer(tx.id);
    await vi.waitFor(() => expect(order).toContain('abort-1-start'));
    expect(order).not.toContain('open-2');
    // Late stale update with tx.signal cannot clobber the active retry
    reportDownloadTransferProgress(tx.id, 999, 1000, Date.now(), tx.signal);
    expect(getDownloadTransfers()[0]?.loadedBytes).toBe(0);

    resolveDelayedAbort();
    await attempt1Promise;
    await resumePromise;

    expect(order).toEqual(['open-1', 'write-1', 'abort-1-start', 'abort-1-end', 'open-2', 'write-2', 'close-2']);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.COMPLETED);
    expect(canRevealDownloadTransfer(tx.id)).toBe(true);
  });

  it('[P0-2] resets R2 preparation bytes when switching to HTTP download/disk write so progress tracks actual written bytes', async () => {
    const { FILE_RELAY_MODE, R2_RELAY_PHASE } = await import('@shared/r2-relay.js');
    const { saveFileRelayMode, setServerR2RelayEnabled } = await import('../src/r2-relay-preference.js');
    const api = await import('../src/api.js');
    api.configure('https://hub.example');
    api.configureExpectedUserId('user-r2');
    setServerR2RelayEnabled(true);
    saveFileRelayMode('user-r2', FILE_RELAY_MODE.R2);

    try {
      const observedSnapshots: Array<{ route: string; status: string; loadedBytes: number; totalBytes: number | null }> = [];
      const { subscribeDownloadTransfers } = await import('../src/download-transfer-store.js');
      const unsubscribe = subscribeDownloadTransfers(() => {
        const row = getDownloadTransfers()[0];
        if (row) {
          observedSnapshots.push({
            route: row.route,
            status: row.status,
            loadedBytes: row.loadedBytes,
            totalBytes: row.totalBytes,
          });
        }
      });

      const downloads = {
        pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-r2-att', name: 'bundle.tar' })),
        openWriter: vi.fn(async () => ({ writerId: 'w-r2-att' })),
        writeChunk: vi.fn(async ({ chunk }: { chunk: Uint8Array | ArrayBuffer }) => ({
          bytesWritten: chunk.byteLength,
          position: chunk.byteLength,
        })),
        closeWriter: vi.fn(async () => undefined),
        abortWriter: vi.fn(async () => undefined),
        getFileSize: vi.fn(async () => ({ size: 1024, name: 'bundle.tar' })),
        revealFile: vi.fn(async () => true),
      };
      (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
        platform: 'darwin',
        isElectron: true,
        downloads,
      };

      let sendSecondChunk!: () => void;
      const ndjson = JSON.stringify({
        phase: R2_RELAY_PHASE.PREPARING,
        loadedBytes: 1024,
        totalBytes: 1024,
        speedBps: 500,
        etaSeconds: 0,
      }) + '\n' + JSON.stringify({
        phase: R2_RELAY_PHASE.READY,
        url: 'https://r2.example/signed-bundle.tar',
      }) + '\n';

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(new TextEncoder().encode(ndjson), { status: 200 }))
        .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(256));
            sendSecondChunk = () => {
              controller.enqueue(new Uint8Array(768));
              controller.close();
            };
          },
        }), { status: 200, headers: { 'content-length': '1024' } }));

      try {
        const downloadPromise = api.downloadAttachmentToCenter('srv-1', 'att-r2', 'bundle.tar');
        await vi.waitFor(() => expect(typeof sendSecondChunk).toBe('function'));
        await vi.waitFor(() => expect(downloads.writeChunk).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(getDownloadTransfers()[0]?.loadedBytes).toBe(256));

        const midRow = getDownloadTransfers()[0]!;
        expect(midRow.route).toBe(DOWNLOAD_TRANSFER_ROUTE.HTTP);
        expect(midRow.status).toBe(DOWNLOAD_TRANSFER_STATUS.TRANSFERRING);
        expect(midRow.loadedBytes).toBe(256);
        expect(midRow.totalBytes).toBe(1024);

        sendSecondChunk();
        await downloadPromise;
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(observedSnapshots.some((s) => s.route === DOWNLOAD_TRANSFER_ROUTE.R2 && s.loadedBytes === 1024)).toBe(true);
        expect(observedSnapshots.some((s) => s.route === DOWNLOAD_TRANSFER_ROUTE.HTTP && s.loadedBytes === 256)).toBe(true);
        expect(getDownloadTransfers()[0]).toMatchObject({
          status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
          route: DOWNLOAD_TRANSFER_ROUTE.HTTP,
          loadedBytes: 1024,
          totalBytes: 1024,
        });
        expect(canRevealDownloadTransfer(getDownloadTransfers()[0]!.id)).toBe(true);
      } finally {
        unsubscribe();
      }
    } finally {
      localStorage.clear();
      setServerR2RelayEnabled(false);
      api.configureExpectedUserId(null);
    }
  });

  it('[P0-3] triggers browser fallback ONLY on destination sink TypeError/refusal, never on source stream TypeError', async () => {
    const api = await import('../src/api.js');
    api.configure('https://hub.example');

    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { writeDownloadDestinationWithFallback } = await import('../src/download-destination-write.js');

    // A. Source-stream TypeError ("Failed to fetch" from reader/fetch) MUST abort writer, stay FAILED with Retry, and NOT trigger anchor
    const srcWriterAbort = vi.fn(async () => undefined);
    const srcWriterClose = vi.fn(async () => undefined);
    const srcDest = {
      handle: {
        createWritable: vi.fn(async () => ({
          write: vi.fn(async () => undefined),
          close: srcWriterClose,
          abort: srcWriterAbort,
        })),
        getFile: vi.fn(async () => new File([], 'src-err.bin')),
      },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '10' }),
      body: {
        getReader: () => ({
          read: vi.fn(async () => {
            throw new TypeError('Failed to fetch');
          }),
          cancel: vi.fn(async () => undefined),
          releaseLock: vi.fn(),
        }),
      },
    }) as unknown as Response);

    // Exhaust attachment retry timers fast using fake timers
    vi.useFakeTimers();
    const pendingSourceErr = api.downloadAttachmentToCenter('srv-1', 'att-src-typeerr', 'src-err.bin', undefined, srcDest);
    const sourceAssertion = expect(pendingSourceErr).rejects.toThrow('Failed to fetch');
    await vi.runAllTimersAsync();
    await sourceAssertion;
    vi.useRealTimers();

    expect(fetchSpy).toHaveBeenCalled();
    expect(srcWriterAbort).toHaveBeenCalled();
    expect(srcWriterClose).not.toHaveBeenCalled();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);
    expect(canRetryDownloadTransfer(getDownloadTransfers()[0]!.id)).toBe(true);

    // B. Positive control: identical TypeError thrown by destination writer.write() in standard browser triggers fallback
    __resetDownloadTransfersForTests();
    const sinkWriterAbort = vi.fn(async () => undefined);
    const sinkDest = {
      handle: {
        createWritable: vi.fn(async () => ({
          write: vi.fn(async () => {
            throw new TypeError('Illegal invocation on FileSystemWritableFileStream');
          }),
          close: vi.fn(async () => undefined),
          abort: sinkWriterAbort,
        })),
      },
    };
    const txSink = beginDownloadTransfer('sink-typeerr.bin');
    const fallbackSpy = vi.fn(async () => undefined);
    const outcome = await writeDownloadDestinationWithFallback({
      transferId: txSink.id,
      destination: sinkDest,
      signal: txSink.signal,
      writeTo: async (writer) => {
        await writer.write(new Uint8Array([1, 2, 3]));
        return true;
      },
      fallbackToBrowser: fallbackSpy,
    });
    expect(outcome).toBe('fallback');
    expect(sinkWriterAbort).toHaveBeenCalledOnce();
    expect(fallbackSpy).toHaveBeenCalledOnce();
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.HANDED_OFF);
  });

  it('[P0-retry-reset] resets loadedBytes/totalBytes/speed/eta when retrying a restart-from-zero transfer while preserving offset for resumable retries', async () => {
    const api = await import('../src/api.js');
    api.configure('https://hub.example');

    // A. Restart-from-zero (downloadAttachmentToCenter): fail after 900/1024 written (close rejects),
    // then retry and pause after writing first 128/1024 bytes -> row must show 128/1024, NOT 900/1024!
    let attempt = 0;
    let sendRetrySecondChunk!: () => void;
    const downloads = {
      pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-retry-0', name: 'big.bin' })),
      openWriter: vi.fn(async () => ({ writerId: `w-retry-${++attempt}` })),
      writeChunk: vi.fn(async ({ chunk }: { chunk: Uint8Array | ArrayBuffer }) => ({
        bytesWritten: chunk.byteLength,
        position: chunk.byteLength,
      })),
      closeWriter: vi.fn(async () => {
        if (attempt === 1) throw new Error('disk_flush_transient_error');
      }),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 1024, name: 'big.bin' })),
      revealFile: vi.fn(async () => true),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads,
    };

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(900), { status: 200, headers: { 'content-length': '900' } }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(128));
          sendRetrySecondChunk = () => {
            controller.enqueue(new Uint8Array(896));
            controller.close();
          };
        },
      }), { status: 200, headers: { 'content-length': '1024' } }));

    await expect(api.downloadAttachmentToCenter('srv-1', 'att-retry-0', 'big.bin')).rejects.toThrow('disk_flush_transient_error');
    const failedRow = getDownloadTransfers()[0]!;
    expect(failedRow.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);
    expect(failedRow.loadedBytes).toBe(900);
    expect(failedRow.totalBytes).toBe(900);
    expect(canRetryDownloadTransfer(failedRow.id)).toBe(true);

    const retryPromise = retryDownloadTransfer(failedRow.id);
    await vi.waitFor(() => expect(typeof sendRetrySecondChunk).toBe('function'));
    await vi.waitFor(() => expect(getDownloadTransfers()[0]?.loadedBytes).toBe(128));

    const midRetry = getDownloadTransfers()[0]!;
    expect(midRetry.status).toBe(DOWNLOAD_TRANSFER_STATUS.TRANSFERRING);
    expect(midRetry.loadedBytes).toBe(128);
    expect(midRetry.totalBytes).toBe(1024);

    sendRetrySecondChunk();
    await retryPromise;
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      loadedBytes: 1024,
      totalBytes: 1024,
    });
    expect(canRevealDownloadTransfer(failedRow.id)).toBe(true);

    // B. Positive control: resumable transfer (preservePrefixOnRetry default true) retains 512 prefix and passes resumeFromBytes=512
    __resetDownloadTransfersForTests();
    const txResumable = beginDownloadTransfer('resume.bin');
    updateDownloadTransfer(txResumable.id, DOWNLOAD_TRANSFER_ROUTE.DIRECT, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING);
    reportDownloadTransferProgress(txResumable.id, 512, 1024, Date.now() + 300, txResumable.signal);
    const seenResumeOffsets: number[] = [];
    setDownloadTransferRetry(txResumable.id, async (sig, resumeFromBytes = 0) => {
      seenResumeOffsets.push(resumeFromBytes);
      updateDownloadTransfer(txResumable.id, DOWNLOAD_TRANSFER_ROUTE.DIRECT, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING, Date.now(), sig);
      reportDownloadTransferProgress(txResumable.id, 1024, 1024, Date.now(), sig);
      completeDownloadTransfer(txResumable.id, false, Date.now(), sig);
    });
    const { failDownloadTransfer } = await import('../src/download-transfer-store.js');
    failDownloadTransfer(txResumable.id, false, Date.now(), txResumable.signal);
    await retryDownloadTransfer(txResumable.id);
    expect(seenResumeOffsets).toEqual([512]);
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      loadedBytes: 1024,
      totalBytes: 1024,
    });
  });
});
