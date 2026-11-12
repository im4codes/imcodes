import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_RELAY_MODE, R2_RELAY_PHASE } from '@shared/r2-relay.js';
import { saveFileRelayMode, readFileRelayMode } from '../src/r2-relay-preference.js';
import { configureExpectedUserId, prepareR2AttachmentDownload, tryUploadR2File, isR2RelaySelected, downloadAttachment } from '../src/api.js';
import { beginDownloadTransfer, getDownloadTransfers, __resetDownloadTransfersForTests, cancelDownloadTransfer,
  reportR2Preparation, updateDownloadTransfer, reportDownloadTransferProgress, DOWNLOAD_TRANSFER_ROUTE, DOWNLOAD_TRANSFER_STATUS } from '../src/download-transfer-store.js';
import { createDownloadTransferWiring } from '../src/download-transfer-wiring.js';
const fetchMock = vi.fn();
beforeEach(() => {
  localStorage.clear(); configureExpectedUserId('user-a'); fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('Headers', new Response().headers.constructor);
  __resetDownloadTransfersForTests();
});
afterEach(() => { __resetDownloadTransfersForTests(); configureExpectedUserId(null); vi.unstubAllGlobals(); });
describe('R2 user routing and progress', () => {
  it('defaults to direct and does not request R2 or emit phases when disabled', async () => {
    const progress = vi.fn();
    expect(isR2RelaySelected()).toBe(false);
    expect(await prepareR2AttachmentDownload('srv', 'abc', undefined, undefined, progress)).toBeNull();
    expect(await tryUploadR2File('srv', new File(['x'], 'a.txt'))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
  });
  it('keeps opt-in scoped to account and falls back unchanged for unconfigured/old server', async () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    expect(readFileRelayMode('user-b')).toBe(FILE_RELAY_MODE.DIRECT);
    expect(readFileRelayMode(null)).toBe(FILE_RELAY_MODE.DIRECT);
    expect(isR2RelaySelected()).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const progress = vi.fn();
    expect(await prepareR2AttachmentDownload('srv', 'abc', undefined, undefined, progress)).toBeNull();
    expect(await tryUploadR2File('srv', new File(['x'], 'a.txt'))).toBeNull();
    expect(progress).not.toHaveBeenCalled();
  });
  it('consumes split NDJSON preparation/ETA and releases only the final signed GET', async () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    const progress = { phase: R2_RELAY_PHASE.PREPARING, loadedBytes: 40, totalBytes: 100, speedBps: 20, etaSeconds: 3 };
    const url = 'https://r2.example/signed-get';
    const text = JSON.stringify(progress) + '\n' + JSON.stringify({ phase: R2_RELAY_PHASE.READY, url });
    const bytes = new TextEncoder().encode(text);
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 15)); c.enqueue(bytes.slice(15)); c.close(); } })));
    const callback = vi.fn();
    expect(await prepareR2AttachmentDownload('srv', 'abc', 'deck_test_brain', undefined, callback)).toBe(url);
    expect(callback).toHaveBeenCalledExactlyOnceWith(progress);
    expect(fetchMock.mock.calls[0]![0]).toContain('/api/server/srv/r2-relay/downloads/abc?sessionName=deck_test_brain');
  });
  it('does not release a URL for failed or prematurely ended preparation', async () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ phase: R2_RELAY_PHASE.ERROR }) + '\n'))
      .mockResolvedValueOnce(new Response(''));
    await expect(prepareR2AttachmentDownload('srv', 'abc')).rejects.toThrow();
    await expect(prepareR2AttachmentDownload('srv', 'abc')).rejects.toThrow();
  });
  it('uploads browser bytes directly to signed PUT then commits metadata with no app credentials on PUT', async () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    fetchMock.mockResolvedValueOnce(Response.json({ id: 'ticket', url: 'https://r2.example/signed-put' }))
      .mockResolvedValueOnce(Response.json({ ok: true, attachment: { id: 'attachment' } }));
    const open = vi.fn(); const send = vi.fn(); const headers = vi.fn();
    class Xhr {
      upload = {}; status = 200; onload?: () => void;
      open = open; setRequestHeader = headers; abort = vi.fn();
      send(file: File) { send(file); this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', Xhr);
    const file = new File([new Uint8Array([0, 255])], 'binary.bin');
    expect((await tryUploadR2File('srv', file))?.attachment.id).toBe('attachment');
    expect(open).toHaveBeenCalledWith('PUT', 'https://r2.example/signed-put');
    expect(send).toHaveBeenCalledWith(file); expect(headers).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[1]![0]).toContain('/r2-relay/uploads/ticket/commit');
  });
  it('keeps default native-browser handoff working with a signal on older WebViews without AbortSignal.any', async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(Response.json({ token: 'download-token' }));
    try {
      await downloadAttachment('srv', 'abc', undefined, new AbortController().signal);
      expect(click).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled(); // cookie-auth browser path requires no token request
    } finally {
      if (original) Object.defineProperty(AbortSignal, 'any', original);
      click.mockRestore();
    }
  });

  it('canceling a standalone R2 preparation row aborts its reader and never hands off the URL', async () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_path, init) => {
      requestSignal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ phase: R2_RELAY_PHASE.PREPARING, loadedBytes: 1, totalBytes: 10, speedBps: 1, etaSeconds: 9 }) + '\n'));
        requestSignal!.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      } }));
    });
    const pending = downloadAttachment('srv', 'abc');
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(getDownloadTransfers()).toHaveLength(1));
    cancelDownloadTransfer(getDownloadTransfers()[0]!.id);
    await assertion;
    expect(requestSignal!.aborted).toBe(true); expect(click).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it('routes a selected R2 download before WebRTC and streams signed GET into the chosen destination', async () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    const progress = { phase: R2_RELAY_PHASE.PREPARING, loadedBytes: 3, totalBytes: 3, speedBps: 1, etaSeconds: 0 };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(progress) + '\n' + JSON.stringify({ phase: R2_RELAY_PHASE.READY, url: 'https://r2.example/signed-get' }) + '\n'))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 255, 128]), { headers: { 'content-length': '3' } }));
    const write = vi.fn(); const close = vi.fn(); const abort = vi.fn(); const callback = vi.fn();
    const { downloadPreviewWithDirectFallback } = await import('../src/direct-file-transfer.js');
    await downloadPreviewWithDirectFallback({ ws: {} as never, serverId: 'srv', previewHandle: 'abc',
      destination: { handle: { createWritable: async () => ({ write, close, abort }) } } as never, onProgress: callback });
    expect(Array.from(write.mock.calls[0]![0] as Uint8Array)).toEqual([0, 255, 128]);
    expect(close).toHaveBeenCalledTimes(1); expect(abort).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(progress);
    expect(callback).toHaveBeenLastCalledWith({ loadedBytes: 3, totalBytes: 3 });
    expect(fetchMock.mock.calls[1]![0]).toBe('https://r2.example/signed-get');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ credentials: 'omit' });
  });

  it('routes a selected R2 upload before WebRTC and clears the upload retry identity on success', async () => {
    saveFileRelayMode('user-a', FILE_RELAY_MODE.R2);
    fetchMock.mockResolvedValueOnce(Response.json({ id: 'ticket', url: 'https://r2.example/signed-put' }))
      .mockResolvedValueOnce(Response.json({ ok: true, attachment: { id: 'attachment' } }));
    class Xhr {
      upload = {}; status = 200; onload?: () => void;
      open = vi.fn(); abort = vi.fn();
      send() { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', Xhr);
    const { uploadFileWithDirectFallback } = await import('../src/direct-file-transfer.js');
    expect((await uploadFileWithDirectFallback({ ws: {} as never, serverId: 'srv', file: new File(['x'], 'r2.txt') })).attachment.id).toBe('attachment');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows preparation bytes/ETA, resets at GET, and ignores canceled owner progress', () => {
    const { id } = beginDownloadTransfer('a.txt'); const wiring = createDownloadTransferWiring(id);
    const progress = { phase: R2_RELAY_PHASE.PREPARING, loadedBytes: 100, totalBytes: 100, speedBps: 50, etaSeconds: 0 };
    wiring.onProgress(progress);
    expect(getDownloadTransfers()[0]).toMatchObject({ route: DOWNLOAD_TRANSFER_ROUTE.R2, status: DOWNLOAD_TRANSFER_STATUS.PREPARING, loadedBytes: 100, etaSeconds: 0 });
    updateDownloadTransfer(id, DOWNLOAD_TRANSFER_ROUTE.HTTP, DOWNLOAD_TRANSFER_STATUS.TRANSFERRING, 1000);
    reportDownloadTransferProgress(id, 20, 100, 2000);
    expect(getDownloadTransfers()[0]).toMatchObject({ loadedBytes: 20, etaSeconds: null });
    cancelDownloadTransfer(id);
    reportR2Preparation(id, progress);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.CANCELED);
  });
});
