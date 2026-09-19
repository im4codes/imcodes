// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBlobViaDownloadAnchor, shareBlobOrDownload } from '../src/browser-download.js';

const nativePluginMocks = vi.hoisted(() => ({
  native: false,
  platform: 'android',
  available: new Set<string>(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  share: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => nativePluginMocks.native,
    getPlatform: () => nativePluginMocks.platform,
    isPluginAvailable: (name: string) => nativePluginMocks.available.has(name),
  },
  registerPlugin: (name: string) => name === 'Filesystem'
    ? { writeFile: nativePluginMocks.writeFile, deleteFile: nativePluginMocks.deleteFile }
    : { share: nativePluginMocks.share },
}));

describe('browser download', () => {
  beforeEach(() => {
    nativePluginMocks.native = false;
    nativePluginMocks.platform = 'android';
    nativePluginMocks.available.clear();
    nativePluginMocks.writeFile.mockReset();
    nativePluginMocks.deleteFile.mockReset();
    nativePluginMocks.share.mockReset();
  });

  afterEach(() => {
    delete (navigator as Navigator & { share?: Navigator['share'] }).share;
    delete (navigator as Navigator & { canShare?: Navigator['canShare'] }).canShare;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('clicks a named blob download and revokes its URL after the handoff', async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:mobile-download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const blob = new Blob(['payload']);
    saveBlobViaDownloadAnchor(blob, 'report.pdf');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.href).toBe('blob:mobile-download');
    expect(anchor.download).toBe('report.pdf');
    expect(anchor.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mobile-download');
  });

  it('opens the system share sheet with the downloaded file when file sharing is supported', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn(() => true);
    Object.defineProperties(navigator, {
      share: { configurable: true, value: share },
      canShare: { configurable: true, value: canShare },
    });

    const result = await shareBlobOrDownload(new Blob(['payload'], { type: 'application/pdf' }), 'report.pdf');

    expect(result).toBe('shared');
    expect(canShare).toHaveBeenCalledOnce();
    expect(share).toHaveBeenCalledOnce();
    const payload = share.mock.calls[0]![0] as ShareData;
    expect(payload.title).toBe('report.pdf');
    expect(payload.files).toHaveLength(1);
    expect(payload.files?.[0]).toMatchObject({ name: 'report.pdf', type: 'application/pdf', size: 7 });
  });

  it('calls Web Share before yielding so an explicit save tap keeps user activation', async () => {
    let active = true;
    queueMicrotask(() => { active = false; });
    const share = vi.fn(() => active
      ? Promise.resolve()
      : Promise.reject(new DOMException('gesture expired', 'NotAllowedError')));
    Object.defineProperties(navigator, {
      share: { configurable: true, value: share },
      canShare: { configurable: true, value: vi.fn(() => true) },
    });

    await expect(shareBlobOrDownload(new Blob(['payload']), 'report.pdf')).resolves.toBe('shared');
    expect(share).toHaveBeenCalledOnce();
  });

  it('does not use embedded Capacitor file sharing on iOS', async () => {
    nativePluginMocks.native = true;
    nativePluginMocks.platform = 'ios';
    nativePluginMocks.available.add('Filesystem');
    nativePluginMocks.available.add('Share');
    const webShare = vi.fn().mockResolvedValue(undefined);
    Object.defineProperties(navigator, {
      share: { configurable: true, value: webShare },
      canShare: { configurable: true, value: vi.fn(() => true) },
    });

    await expect(shareBlobOrDownload(new Blob(['payload']), 'report.pdf')).resolves.toBe('shared');

    expect(nativePluginMocks.writeFile).not.toHaveBeenCalled();
    expect(nativePluginMocks.share).not.toHaveBeenCalled();
    expect(webShare).toHaveBeenCalledOnce();
  });

  it('reuses embedded Capacitor Filesystem and Share plugins before browser Web Share', async () => {
    nativePluginMocks.native = true;
    nativePluginMocks.available.add('Filesystem');
    nativePluginMocks.available.add('Share');
    nativePluginMocks.writeFile.mockResolvedValue({ uri: 'file:///cache/report.pdf' });
    nativePluginMocks.deleteFile.mockResolvedValue(undefined);
    nativePluginMocks.share.mockResolvedValue(undefined);
    const webShare = vi.fn();
    Object.defineProperty(navigator, 'share', { configurable: true, value: webShare });

    await expect(shareBlobOrDownload(new Blob(['payload']), 'report.pdf')).resolves.toBe('shared');

    expect(nativePluginMocks.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      data: 'cGF5bG9hZA==',
      directory: 'CACHE',
    }));
    expect(nativePluginMocks.share).toHaveBeenCalledWith({ url: 'file:///cache/report.pdf', title: 'report.pdf' });
    expect(nativePluginMocks.deleteFile).toHaveBeenCalledOnce();
    expect(webShare).not.toHaveBeenCalled();
  });

  it('keeps share-sheet cancellation terminal instead of silently claiming a saved download', async () => {
    const canceled = new DOMException('canceled', 'AbortError');
    Object.defineProperties(navigator, {
      share: { configurable: true, value: vi.fn().mockRejectedValue(canceled) },
      canShare: { configurable: true, value: vi.fn(() => true) },
    });

    await expect(shareBlobOrDownload(new Blob(['payload']), 'report.pdf')).rejects.toBe(canceled);
  });

  it('falls back to a named browser download when file sharing is unavailable', async () => {
    vi.useFakeTimers();
    Object.defineProperties(navigator, {
      share: { configurable: true, value: undefined },
      canShare: { configurable: true, value: undefined },
    });
    const createObjectURL = vi.fn(() => 'blob:fallback-download');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await expect(shareBlobOrDownload(new Blob(['payload']), 'report.pdf')).resolves.toBe('downloaded');
    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe('report.pdf');
  });
});
