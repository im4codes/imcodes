/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_FILE_TRANSFER_ERROR } from '@shared/direct-file-transfer.js';
import {
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  __resetDownloadTransfersForTests,
  canRevealDownloadTransfer,
  canRetryDownloadTransfer,
  cancelDownloadTransfer,
  getDownloadTransfers,
  retryDownloadTransfer,
} from '../src/download-transfer-store.js';

const nativeState = vi.hoisted(() => ({ native: false }));
const browserOpenMock = vi.hoisted(() => vi.fn(async () => undefined));
const saveBlobViaDownloadAnchorMock = vi.hoisted(() => vi.fn());

vi.mock('../src/native.js', () => ({
  isNative: () => nativeState.native,
}));

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: browserOpenMock,
  },
}));

vi.mock('../src/browser-download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/browser-download.js')>()),
  saveBlobViaDownloadAnchor: saveBlobViaDownloadAnchorMock,
}));

const api = await import('../src/api.js');

function makeStreamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers,
  });
}

describe('downloadCloudDocApi transfer center integration', () => {
  const originalShowSaveFilePicker = (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  const originalShowOpenFilePicker = (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetDownloadTransfersForTests();
    nativeState.native = false;
    browserOpenMock.mockReset();
    saveBlobViaDownloadAnchorMock.mockReset();
    api.configure('https://hub.example');
  });

  afterEach(() => {
    __resetDownloadTransfersForTests();
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = originalShowSaveFilePicker;
    (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker = originalShowOpenFilePicker;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('opens showSaveFilePicker before fetch, streams to writable, completes transfer, and attaches savedFile handle', async () => {
    const written: Uint8Array[] = [];
    const writer = {
      write: vi.fn(async (data: BufferSource) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        written.push(bytes.slice());
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const handle = {
      createWritable: vi.fn(async () => writer),
      getFile: vi.fn(async () => new File([], 'report.docx')),
    };
    const showSaveFilePicker = vi.fn(async () => handle);
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = showSaveFilePicker;
    (globalThis as { showOpenFilePicker?: unknown }).showOpenFilePicker = vi.fn(async () => []);

    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7, 8, 9]);
    const fetchMock = vi.fn(async () => makeStreamResponse([chunk1, chunk2], {
      'content-length': '9',
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await api.downloadCloudDocApi('doc-123', 'report.docx');

    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'report.docx' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(showSaveFilePicker.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://hub.example/api/cloud-docs/doc-123/download?download=1');
    expect(writer.write).toHaveBeenCalledTimes(2);
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(written.reduce((sum, b) => sum + b.byteLength, 0)).toBe(9);

    const items = getDownloadTransfers();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: 'report.docx',
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      route: DOWNLOAD_TRANSFER_ROUTE.HTTP,
      loadedBytes: 9,
      totalBytes: 9,
    });
    expect(canRevealDownloadTransfer(items[0]!.id)).toBe(true);
    expect(saveBlobViaDownloadAnchorMock).not.toHaveBeenCalled();
  });

  it('returns silently without creating a transfer row or calling fetch when save picker is canceled', async () => {
    const abortErr = new DOMException('User aborted', 'AbortError');
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => {
      throw abortErr;
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(api.downloadCloudDocApi('doc-cancel', 'cancel.docx')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getDownloadTransfers()).toEqual([]);
  });

  it('streams via browser download anchor and marks HANDED_OFF when showSaveFilePicker is unavailable, including zero-byte/unknown Content-Length', async () => {
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
    const fetchMock = vi.fn(async () => makeStreamResponse([], {
      'content-type': 'text/plain',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await api.downloadCloudDocApi('doc-zero', 'empty.txt');

    expect(saveBlobViaDownloadAnchorMock).toHaveBeenCalledTimes(1);
    const [blob, savedName] = saveBlobViaDownloadAnchorMock.mock.calls[0] as [Blob, string];
    expect(savedName).toBe('empty.txt');
    expect(blob.size).toBe(0);
    expect(blob.type).toBe('text/plain');

    const items = getDownloadTransfers();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: 'empty.txt',
      status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      route: DOWNLOAD_TRANSFER_ROUTE.BROWSER,
      loadedBytes: 0,
      totalBytes: null,
    });
    expect(canRevealDownloadTransfer(items[0]!.id)).toBe(false);
  });

  it('falls back to browser download on File System Access SecurityError/NotAllowedError without failing the row', async () => {
    const handle = {
      createWritable: vi.fn(async () => {
        throw new DOMException('Restricted type', 'SecurityError');
      }),
    };
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => handle);

    const payload = new Uint8Array([10, 20, 30]);
    globalThis.fetch = vi.fn(async () => makeStreamResponse([payload], {
      'content-length': '3',
      'content-type': 'image/svg+xml',
    })) as unknown as typeof fetch;

    await api.downloadCloudDocApi('doc-svg', 'diagram.svg');

    expect(saveBlobViaDownloadAnchorMock).toHaveBeenCalledTimes(1);
    expect((saveBlobViaDownloadAnchorMock.mock.calls[0]![0] as Blob).size).toBe(3);
    expect(getDownloadTransfers()[0]).toMatchObject({
      name: 'diagram.svg',
      status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      route: DOWNLOAD_TRANSFER_ROUTE.BROWSER,
      loadedBytes: 3,
      totalBytes: 3,
    });
  });

  it('keeps disk-full QuotaExceededError as FAILED instead of silently falling back', async () => {
    const writer = {
      write: vi.fn(async () => {
        throw new DOMException('No space left on device', 'QuotaExceededError');
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const handle = {
      createWritable: vi.fn(async () => writer),
    };
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => handle);
    globalThis.fetch = vi.fn(async () => makeStreamResponse([new Uint8Array([1, 2])], {
      'content-length': '2',
    })) as unknown as typeof fetch;

    await expect(api.downloadCloudDocApi('doc-full', 'big.pptx')).rejects.toThrow(/No space/i);
    expect(writer.abort).toHaveBeenCalledTimes(1);
    expect(saveBlobViaDownloadAnchorMock).not.toHaveBeenCalled();
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);
  });

  it('marks HTTP errors FAILED and supports retryDownloadTransfer to completion', async () => {
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
    let attempt = 0;
    globalThis.fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response('server error', { status: 500 });
      }
      return makeStreamResponse([new Uint8Array([7, 8, 9])], { 'content-length': '3' });
    }) as unknown as typeof fetch;

    await expect(api.downloadCloudDocApi('doc-retry', 'notes.md')).rejects.toMatchObject({ status: 500 });

    const failed = getDownloadTransfers()[0]!;
    expect(failed.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);
    expect(canRetryDownloadTransfer(failed.id)).toBe(true);

    await retryDownloadTransfer(failed.id);
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      route: DOWNLOAD_TRANSFER_ROUTE.BROWSER,
      loadedBytes: 3,
      totalBytes: 3,
    });
    expect(saveBlobViaDownloadAnchorMock).toHaveBeenCalledTimes(1);
  });

  it('aborts fetch & writer and marks CANCELED cleanly when canceled in flight', async () => {
    let cancelStream!: () => void;
    const readerCancelMock = vi.fn(async () => undefined);
    const writer = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => writer,
    }));

    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '100' }),
        body: {
          getReader: () => ({
            read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              cancelStream = () => resolve({ done: true });
              signal?.addEventListener('abort', () => resolve({ done: true }), { once: true });
            }),
            cancel: readerCancelMock,
          }),
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const promise = api.downloadCloudDocApi('doc-inflight', 'huge.pdf');
    await vi.waitFor(() => expect(getDownloadTransfers()).toHaveLength(1));
    await vi.waitFor(() => expect(typeof cancelStream).toBe('function'));

    const id = getDownloadTransfers()[0]!.id;
    cancelDownloadTransfer(id);
    await expect(promise).resolves.toBeUndefined();

    expect(writer.abort).toHaveBeenCalledTimes(1);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.CANCELED);
  });

  it('tracks native mobile downloads in DownloadTransferCenter using Browser.open and ticket minting', async () => {
    nativeState.native = true;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ticket: 't-1',
      downloadPath: '/api/cloud-docs/download-ticket/t-1',
      expiresInSeconds: 60,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await api.downloadCloudDocApi('doc-mobile', 'slides.pptx');

    expect(browserOpenMock).toHaveBeenCalledWith({
      url: 'https://hub.example/api/cloud-docs/download-ticket/t-1',
    });
    expect(getDownloadTransfers()[0]).toMatchObject({
      name: 'slides.pptx',
      status: DOWNLOAD_TRANSFER_STATUS.HANDED_OFF,
      route: DOWNLOAD_TRANSFER_ROUTE.BROWSER,
    });
    // Ensure DIRECT_FILE_TRANSFER_ERROR import remains intact in test environment.
    expect(DIRECT_FILE_TRANSFER_ERROR.CANCELED).toBe('canceled');
  });
});
