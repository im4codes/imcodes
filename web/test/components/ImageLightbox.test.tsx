import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageLightbox } from '../../src/components/ImageLightbox.js';
import {
  __resetDownloadTransfersForTests,
  canRetryDownloadTransfer,
  canRevealDownloadTransfer,
  cancelDownloadTransfer,
  DOWNLOAD_TRANSFER_ROUTE,
  DOWNLOAD_TRANSFER_STATUS,
  getDownloadTransfers,
  retryDownloadTransfer,
  revealDownloadTransfer,
} from '../../src/download-transfer-store.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split('.').pop() ?? key,
  }),
}));

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;
const originalMaxTouchPoints = navigator.maxTouchPoints;

function setMobilePointer() {
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    value: 5,
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 390,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true }),
  });
}

/** Reads the scale currently applied via the `transform` inline style, defaulting to 1x. */
function readScale(image: HTMLImageElement): number {
  const match = /scale\(([-\d.]+)\)/.exec(image.style.transform);
  return match ? Number(match[1]) : 1;
}

/** Reads the pan translate currently applied via the `transform` inline style. */
function readTranslate(image: HTMLImageElement): { x: number; y: number } {
  const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/.exec(image.style.transform);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
}

/**
 * Gives the lightbox a real (mocked) stage/content size so
 * clampRemoteDesktopViewport's pan bounds are not degenerate -- jsdom lays
 * out everything at 0x0 otherwise.
 */
function stubLightboxGeometry(container: HTMLElement) {
  const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
  const stage = container.querySelector('.fb-lightbox') as HTMLDivElement;
  Object.defineProperty(image, 'offsetWidth', { configurable: true, value: 300 });
  Object.defineProperty(image, 'offsetHeight', { configurable: true, value: 300 });
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 400 });
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    left: 50, top: 50, width: 300, height: 300, right: 350, bottom: 350,
    x: 50, y: 50, toJSON: () => ({}),
  } as DOMRect);
  return { image, stage };
}

describe('ImageLightbox', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetDownloadTransfersForTests();
    delete (globalThis as typeof globalThis & { __IMCODES_PC_APP__?: unknown }).__IMCODES_PC_APP__;
    delete (globalThis as typeof globalThis & { ClipboardItem?: unknown }).ClipboardItem;
    delete (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (globalThis as typeof globalThis & { showOpenFilePicker?: unknown }).showOpenFilePicker;
    delete (navigator as Navigator & { share?: Navigator['share'] }).share;
    delete (navigator as Navigator & { canShare?: Navigator['canShare'] }).canShare;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: originalMaxTouchPoints,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  });

  it('reveals image actions on mobile long press and supports linked download/copy', async () => {
    vi.useFakeTimers();
    setMobilePointer();
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
    } as Response);
    class TestClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }
    (globalThis as typeof globalThis & { ClipboardItem?: typeof TestClipboardItem }).ClipboardItem = TestClipboardItem;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: clipboardWrite },
    });

    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,aW1n"
        alt="screens/result.png"
        onDownload={onDownload}
        onClose={vi.fn()}
      />,
    );

    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.touchStart(image);
    act(() => {
      vi.advanceTimersByTime(540);
    });

    const actions = container.querySelector('.fb-lightbox-actions');
    expect(actions).not.toBeNull();
    vi.useRealTimers();

    const downloadButton = container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(downloadButton);
    await waitFor(() => {
      expect(onDownload).toHaveBeenCalledTimes(1);
    });
    expect(downloadButton.textContent).toBe('image_downloaded');

    const copyButton = container.querySelectorAll('.fb-lightbox-action')[1] as HTMLButtonElement;
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(clipboardWrite).toHaveBeenCalledTimes(1);
    });
    expect(fetchSpy).toHaveBeenCalledWith('data:image/png;base64,aW1n');
    expect(copyButton.textContent).toBe('image_copied');
  });

  it('uses the system share surface for standalone mobile image downloads when available', async () => {
    setMobilePointer();
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn(() => true);
    Object.defineProperties(navigator, {
      share: { configurable: true, value: share },
      canShare: { configurable: true, value: canShare },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
    } as Response);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,aW1n"
        alt="result"
        onClose={vi.fn()}
      />,
    );

    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.contextMenu(image);
    const saveButton = container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('data:image/png;base64,aW1n');
      expect(share).toHaveBeenCalledOnce();
    });
    expect(canShare).toHaveBeenCalledOnce();
    expect(anchorClick).not.toHaveBeenCalled();
    expect(saveButton.textContent).toBe('image_downloaded');
  });

  it('falls back to blob URL download when no linked download handler is provided', async () => {
    setMobilePointer();
    const createObjectURL = vi.fn(() => 'blob:image-preview');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['image'], { type: 'image/webp' })),
    } as Response);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const { container } = render(
      <ImageLightbox
        src="data:image/webp;base64,aW1n"
        alt="result"
        onClose={vi.fn()}
      />,
    );

    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.contextMenu(image);
    const saveButton = container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('data:image/webp;base64,aW1n');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(anchorClick).toHaveBeenCalledTimes(1);
      expect(saveButton.textContent).toBe('image_downloaded');
    });
  });

  it('shows explicit copy and save actions from the desktop image context menu', async () => {
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    });
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    class TestClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }
    (globalThis as typeof globalThis & { ClipboardItem?: typeof TestClipboardItem }).ClipboardItem = TestClipboardItem;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: clipboardWrite },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })),
    } as Response);
    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,aW1n"
        alt="result.png"
        onClose={vi.fn()}
      />,
    );

    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.contextMenu(image);

    const actions = container.querySelector('.fb-lightbox-actions');
    expect(actions).not.toBeNull();
    const copyButton = container.querySelectorAll('.fb-lightbox-action')[1] as HTMLButtonElement;
    fireEvent.click(copyButton);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    expect(copyButton.textContent).toBe('image_copied');
  });

  it('reveals image actions from the mobile image context menu', () => {
    setMobilePointer();
    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,aW1n"
        alt="result.png"
        onClose={vi.fn()}
      />,
    );

    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.contextMenu(image);

    expect(container.querySelector('.fb-lightbox-actions')).not.toBeNull();
  });

  it('starts the mobile save action from a touch long press even when touch capabilities are not advertised', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    });
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,aW1n"
        alt="result.png"
        onDownload={onDownload}
        onClose={vi.fn()}
      />,
    );
    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.touchStart(image, { touches: [{ clientX: 100, clientY: 100 }] });
    act(() => vi.advanceTimersByTime(540));
    const saveButton = container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    expect(saveButton).not.toBeNull();
    vi.useRealTimers();
    fireEvent.click(saveButton);
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
  });

  describe('zoom and pan (tsk_v0v)', () => {
    it('pinch-to-zoom increases scale, anchored around the pinch midpoint', () => {
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />,
      );
      const { image } = stubLightboxGeometry(container);

      expect(readScale(image)).toBe(1);
      // Two fingers 100px apart, spreading to 200px apart -- distance
      // doubles, so scale should double too (clamped to [1, 4]).
      fireEvent.touchStart(image, {
        touches: [{ clientX: 150, clientY: 150 }, { clientX: 250, clientY: 150 }],
      });
      fireEvent.touchMove(image, {
        touches: [{ clientX: 100, clientY: 150 }, { clientX: 300, clientY: 150 }],
      });

      expect(readScale(image)).toBeCloseTo(2, 5);
    });

    it('clamps pinch zoom to the 1x-4x range', () => {
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />,
      );
      const { image } = stubLightboxGeometry(container);

      // Distance goes from 50px to 5000px -- a 100x spread, clamped to 4x.
      fireEvent.touchStart(image, {
        touches: [{ clientX: 175, clientY: 150 }, { clientX: 225, clientY: 150 }],
      });
      fireEvent.touchMove(image, {
        touches: [{ clientX: -2350, clientY: 150 }, { clientX: 2650, clientY: 150 }],
      });

      expect(readScale(image)).toBeCloseTo(4, 5);
    });

    it('a pinch-start cancels a pending long-press timer', () => {
      vi.useFakeTimers();
      setMobilePointer();
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.touchStart(image, { touches: [{ clientX: 150, clientY: 150 }] });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      // Second finger lands before the long-press would fire.
      fireEvent.touchStart(image, {
        touches: [{ clientX: 150, clientY: 150 }, { clientX: 250, clientY: 150 }],
      });
      act(() => {
        vi.advanceTimersByTime(540);
      });

      expect(container.querySelector('.fb-lightbox-actions')).toBeNull();
    });

    it('mouse wheel zoom changes scale, anchored at the cursor', () => {
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.wheel(image, { deltaY: -300, clientX: 200, clientY: 200 });

      expect(readScale(image)).toBeGreaterThan(1);
    });

    it('drag-to-dismiss still works when not zoomed (scale=1)', () => {
      const onClose = vi.fn();
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={onClose} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.touchStart(image, { touches: [{ clientX: 200, clientY: 200 }] });
      fireEvent.touchMove(image, { touches: [{ clientX: 200, clientY: 320 }] });
      fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 200, clientY: 320 }] });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not dismiss on a short vertical drag under the threshold', () => {
      const onClose = vi.fn();
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={onClose} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.touchStart(image, { touches: [{ clientX: 200, clientY: 200 }] });
      fireEvent.touchMove(image, { touches: [{ clientX: 200, clientY: 240 }] });
      fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 200, clientY: 240 }] });

      expect(onClose).not.toHaveBeenCalled();
    });

    it('drag pans the image within bounds instead of dismissing when zoomed in', () => {
      const onClose = vi.fn();
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={onClose} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.wheel(image, { deltaY: -600, clientX: 200, clientY: 200 });
      expect(readScale(image)).toBeGreaterThan(1);
      // The wheel-zoom step itself already shifts the pan slightly (its
      // cursor anchor is not exactly image-center), so compare the drag's
      // effect against that baseline rather than asserting some absolute
      // sign -- this is what actually isolates the drag-pan behavior.
      const beforeDrag = readTranslate(image).y;

      fireEvent.touchStart(image, { touches: [{ clientX: 200, clientY: 200 }] });
      fireEvent.touchMove(image, { touches: [{ clientX: 200, clientY: 320 }] });
      fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 200, clientY: 320 }] });

      expect(onClose).not.toHaveBeenCalled();
      expect(readTranslate(image).y).toBeGreaterThan(beforeDrag);
    });

    it('double-tap resets zoom to 1x', () => {
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.wheel(image, { deltaY: -300, clientX: 200, clientY: 200 });
      expect(readScale(image)).toBeGreaterThan(1);

      fireEvent.touchStart(image, { touches: [{ clientX: 200, clientY: 200 }] });
      fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 200, clientY: 200 }] });
      fireEvent.touchStart(image, { touches: [{ clientX: 204, clientY: 204 }] });
      fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 204, clientY: 204 }] });

      expect(readScale(image)).toBe(1);
    });

    it('a lone tap (no second tap in time) does not reset zoom', () => {
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.wheel(image, { deltaY: -300, clientX: 200, clientY: 200 });
      const zoomed = readScale(image);
      expect(zoomed).toBeGreaterThan(1);

      fireEvent.touchStart(image, { touches: [{ clientX: 200, clientY: 200 }] });
      fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 200, clientY: 200 }] });

      expect(readScale(image)).toBeCloseTo(zoomed, 5);
    });

    it('double-click resets zoom to 1x', () => {
      const { container } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.wheel(image, { deltaY: -300, clientX: 200, clientY: 200 });
      expect(readScale(image)).toBeGreaterThan(1);

      fireEvent.dblClick(image);

      expect(readScale(image)).toBe(1);
    });

    it('resets scale and pan when the displayed image changes', () => {
      const onClose = vi.fn();
      const { container, rerender } = render(
        <ImageLightbox src="data:image/png;base64,aW1n" onClose={onClose} onNavigate={vi.fn()} canNext />,
      );
      const { image } = stubLightboxGeometry(container);

      fireEvent.wheel(image, { deltaY: -300, clientX: 200, clientY: 200 });
      expect(readScale(image)).toBeGreaterThan(1);

      rerender(
        <ImageLightbox src="data:image/png;base64,YW5vdGhlcg==" onClose={onClose} onNavigate={vi.fn()} canNext />,
      );

      const nextImage = container.querySelector('.fb-lightbox img') as HTMLImageElement;
      expect(readScale(nextImage)).toBe(1);
      expect(readTranslate(nextImage)).toEqual({ x: 0, y: 0 });
    });
  });

  it('streams fallback image save through PC App bridge before fetch, tracks in DownloadTransferCenter, and reveals natively', async () => {
    const chunks: Uint8Array[] = [];
    const downloads = {
      pickSaveFile: vi.fn(async () => ({
        canceled: false as const,
        handleId: 'h-img-1',
        name: 'preview.png',
      })),
      openWriter: vi.fn(async () => ({ writerId: 'w-img-1' })),
      writeChunk: vi.fn(async ({ chunk }: { chunk: Uint8Array | ArrayBuffer }) => {
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk);
        chunks.push(bytes.slice());
        return { bytesWritten: bytes.byteLength, position: bytes.byteLength };
      }),
      closeWriter: vi.fn(async () => undefined),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 5, name: 'preview.png' })),
      revealFile: vi.fn(async () => true),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['PNG!!'], { type: 'image/png' })),
    } as Response);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,UE5HISE="
        fileName="preview.png"
        onClose={vi.fn()}
      />,
    );

    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.contextMenu(image);
    const saveButton = container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(saveButton);

    // Save picker opens before any fetch()
    expect(downloads.pickSaveFile).toHaveBeenCalledWith({ suggestedName: 'preview.png' });
    expect(fetchSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(saveButton.textContent).toBe('image_downloaded'));
    expect(downloads.pickSaveFile.mock.invocationCallOrder[0]).toBeLessThan(fetchSpy.mock.invocationCallOrder[0]!);
    expect(anchorClick).not.toHaveBeenCalled();
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')).toBe('PNG!!');

    const rows = getDownloadTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'preview.png',
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      route: DOWNLOAD_TRANSFER_ROUTE.HTTP,
      loadedBytes: 5,
      totalBytes: 5,
    });
    expect(canRevealDownloadTransfer(rows[0]!.id)).toBe(true);
    expect(revealDownloadTransfer(rows[0]!.id)).toBe(true);
    expect(downloads.revealFile).toHaveBeenCalledWith({ handleId: 'h-img-1' });
  });

  it('supports Chromium showSaveFilePicker for fallback image saves and resets to idle when save dialog is canceled', async () => {
    const written: Uint8Array[] = [];
    const writer = {
      write: vi.fn(async (data: BufferSource) => {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        written.push(bytes.slice());
      }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    const showSaveFilePicker = vi.fn()
      .mockRejectedValueOnce(new DOMException('canceled', 'AbortError'))
      .mockResolvedValueOnce({
        createWritable: async () => writer,
        getFile: async () => new File([], 'photo.png'),
      });
    (globalThis as Record<string, unknown>).showSaveFilePicker = showSaveFilePicker;
    (globalThis as Record<string, unknown>).showOpenFilePicker = vi.fn(async () => []);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: () => Promise.resolve(new Blob(['IMG'], { type: 'image/png' })),
    } as Response);

    const { container } = render(
      <ImageLightbox
        src="https://hub.example/assets/photo.png"
        alt="photo"
        onClose={vi.fn()}
      />,
    );
    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.contextMenu(image);
    const saveButton = container.querySelector('.fb-lightbox-action') as HTMLButtonElement;

    // 1. Cancel picker -> resets to idle, no fetch, no transfer row
    fireEvent.click(saveButton);
    await waitFor(() => expect(showSaveFilePicker).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton.textContent).toBe('image_download'));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getDownloadTransfers()).toEqual([]);

    // 2. Confirm picker -> downloads and marks revealable
    fireEvent.click(saveButton);
    await waitFor(() => expect(saveButton.textContent).toBe('image_downloaded'));
    expect(Buffer.concat(written.map((c) => Buffer.from(c))).toString('utf8')).toBe('IMG');
    expect(canRevealDownloadTransfer(getDownloadTransfers()[0]!.id)).toBe(true);
  });

  it('handles mid-download cancel, disk-full QuotaExceededError, and File System Access refusal in ImageLightbox', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const createObjectURL = vi.fn(() => 'blob:fallback-img');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    // 1. Mid-download cancel resets button to idle and marks transfer CANCELED
    let rejectPendingFetch!: (err: unknown) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_src, init) => new Promise((_resolve, reject) => {
      rejectPendingFetch = reject;
      (init as RequestInit | undefined)?.signal?.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));
    const abortWriter = vi.fn(async () => undefined);
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'darwin',
      isElectron: true,
      downloads: {
        pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-c', name: 'pic.png' })),
        openWriter: vi.fn(async () => ({ writerId: 'w-c' })),
        writeChunk: vi.fn(),
        closeWriter: vi.fn(),
        abortWriter,
        getFileSize: vi.fn(),
      },
    };

    const view1 = render(<ImageLightbox src="https://hub.example/pic.png" onClose={vi.fn()} />);
    fireEvent.contextMenu(view1.container.querySelector('.fb-lightbox img')!);
    const btn1 = view1.container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(btn1);
    await waitFor(() => expect(getDownloadTransfers()).toHaveLength(1));
    await waitFor(() => expect(typeof rejectPendingFetch).toBe('function'));
    cancelDownloadTransfer(getDownloadTransfers()[0]!.id);
    await waitFor(() => expect(btn1.textContent).toBe('image_download'));
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.CANCELED);
    cleanup();

    // 2. Disk full (QuotaExceededError) marks FAILED + shows error without anchor fallback
    __resetDownloadTransfersForTests();
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads: {
        pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-q', name: 'q.png' })),
        openWriter: vi.fn(async () => ({ writerId: 'w-q' })),
        writeChunk: vi.fn(async () => { throw new Error('ENOSPC: no space left on device'); }),
        closeWriter: vi.fn(),
        abortWriter,
        getFileSize: vi.fn(),
      },
    };
    fetchSpy.mockResolvedValueOnce({ blob: () => Promise.resolve(new Blob(['abc'], { type: 'image/png' })) } as Response);
    const view2 = render(<ImageLightbox src="https://hub.example/q.png" fileName="q.png" onClose={vi.fn()} />);
    fireEvent.contextMenu(view2.container.querySelector('.fb-lightbox img')!);
    const btn2 = view2.container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(btn2);
    await waitFor(() => expect(btn2.textContent).toBe('image_download_failed'));
    expect(abortWriter).toHaveBeenCalledWith({ writerId: 'w-q' });
    expect(anchorClick).not.toHaveBeenCalled();
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);
    cleanup();

    // 3. SecurityError refusal in standard browser falls back to shareBlobOrDownload and completes HANDED_OFF
    __resetDownloadTransfersForTests();
    delete (globalThis as Record<string, unknown>).__IMCODES_PC_APP__;
    (globalThis as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => { throw new DOMException('Blocked extension', 'SecurityError'); },
    }));
    fetchSpy.mockResolvedValueOnce({ blob: () => Promise.resolve(new Blob(['<svg/>'], { type: 'image/svg+xml' })) } as Response);
    const view3 = render(<ImageLightbox src="data:image/svg+xml;base64,PHN2Zy8+" alt="icon" onClose={vi.fn()} />);
    fireEvent.contextMenu(view3.container.querySelector('.fb-lightbox img')!);
    const btn3 = view3.container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(btn3);
    await waitFor(() => expect(btn3.textContent).toBe('image_downloaded'));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.HANDED_OFF);
    cleanup();

    // 4. PC App openWriter refusal fails cleanly without falling back to anchor (no double save dialog)
    __resetDownloadTransfersForTests();
    delete (globalThis as Record<string, unknown>).showSaveFilePicker;
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads: {
        pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-pc-deny', name: 'deny.png' })),
        openWriter: vi.fn(async () => { throw new DOMException('open denied', 'NotAllowedError'); }),
        writeChunk: vi.fn(),
        closeWriter: vi.fn(),
        abortWriter: vi.fn(async () => undefined),
        getFileSize: vi.fn(),
      },
    };
    fetchSpy.mockResolvedValueOnce({ blob: () => Promise.resolve(new Blob(['abc'], { type: 'image/png' })) } as Response);
    const view4 = render(<ImageLightbox src="https://hub.example/deny.png" fileName="deny.png" onClose={vi.fn()} />);
    fireEvent.contextMenu(view4.container.querySelector('.fb-lightbox img')!);
    const btn4 = view4.container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(btn4);
    await waitFor(() => expect(btn4.textContent).toBe('image_download_failed'));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);
    cleanup();

    // 5. Source fetch TypeError fails cleanly in standard browser without triggering anchor fallback
    __resetDownloadTransfersForTests();
    delete (globalThis as Record<string, unknown>).__IMCODES_PC_APP__;
    const srcErrWriter = {
      write: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    };
    (globalThis as Record<string, unknown>).showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => srcErrWriter,
    }));
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view5 = render(<ImageLightbox src="https://hub.example/net-err.png" fileName="net-err.png" onClose={vi.fn()} />);
    fireEvent.contextMenu(view5.container.querySelector('.fb-lightbox img')!);
    const btn5 = view5.container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(btn5);
    await waitFor(() => expect(btn5.textContent).toBe('image_download_failed'));
    expect(srcErrWriter.abort).not.toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(getDownloadTransfers()[0]?.status).toBe(DOWNLOAD_TRANSFER_STATUS.FAILED);
    cleanup();

    // 6. Close failure -> retryDownloadTransfer resets loadedBytes/totalBytes before re-fetching and completes revealable
    __resetDownloadTransfersForTests();
    let imgAttempt = 0;
    let resolveSecondImgFetch!: (res: Response) => void;
    const downloads6 = {
      pickSaveFile: vi.fn(async () => ({ canceled: false as const, handleId: 'h-img-retry', name: 'retry.png' })),
      openWriter: vi.fn(async () => ({ writerId: `w-img-retry-${++imgAttempt}` })),
      writeChunk: vi.fn(async ({ chunk }: { chunk: Uint8Array | ArrayBuffer }) => ({
        bytesWritten: chunk.byteLength,
        position: chunk.byteLength,
      })),
      closeWriter: vi.fn(async () => {
        if (imgAttempt === 1) throw new Error('close_failed_once');
      }),
      abortWriter: vi.fn(async () => undefined),
      getFileSize: vi.fn(async () => ({ size: 5, name: 'retry.png' })),
      revealFile: vi.fn(async () => true),
    };
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = {
      platform: 'win32',
      isElectron: true,
      downloads: downloads6,
    };
    fetchSpy
      .mockResolvedValueOnce({ blob: () => Promise.resolve(new Blob(['12345'], { type: 'image/png' })) } as Response)
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecondImgFetch = resolve; }));

    const view6 = render(<ImageLightbox src="https://hub.example/retry.png" fileName="retry.png" onClose={vi.fn()} />);
    fireEvent.contextMenu(view6.container.querySelector('.fb-lightbox img')!);
    const btn6 = view6.container.querySelector('.fb-lightbox-action') as HTMLButtonElement;
    fireEvent.click(btn6);
    await waitFor(() => expect(btn6.textContent).toBe('image_download_failed'));
    const failedImgRow = getDownloadTransfers()[0]!;
    expect(failedImgRow).toMatchObject({ status: DOWNLOAD_TRANSFER_STATUS.FAILED, loadedBytes: 5, totalBytes: 5 });
    expect(canRetryDownloadTransfer(failedImgRow.id)).toBe(true);

    const retryImgPromise = retryDownloadTransfer(failedImgRow.id);
    await waitFor(() => expect(typeof resolveSecondImgFetch).toBe('function'));
    expect(getDownloadTransfers()[0]).toMatchObject({ loadedBytes: 0, totalBytes: null });

    resolveSecondImgFetch({ blob: () => Promise.resolve(new Blob(['12345'], { type: 'image/png' })) } as Response);
    await retryImgPromise;
    expect(getDownloadTransfers()[0]).toMatchObject({
      status: DOWNLOAD_TRANSFER_STATUS.COMPLETED,
      loadedBytes: 5,
      totalBytes: 5,
    });
    expect(canRevealDownloadTransfer(failedImgRow.id)).toBe(true);
  });
});

describe('ImageLightbox: reading a wide or tall picture (100%, drag-pan, zoom range)', () => {
  /** A 1970 x 350 screenshot fitted at 300 px wide (stubLightboxGeometry): 100% is 6.57x the fitted size. */
  function renderLoaded(onClose = vi.fn(), natural = { width: 1970, height: 350 }) {
    const view = render(<ImageLightbox src="data:image/png;base64,aW1n" onClose={onClose} />);
    const stubbed = stubLightboxGeometry(view.container);
    Object.defineProperty(stubbed.image, 'naturalWidth', { configurable: true, value: natural.width });
    Object.defineProperty(stubbed.image, 'naturalHeight', { configurable: true, value: natural.height });
    act(() => { stubbed.image.dispatchEvent(new Event('load')); });
    return { ...view, ...stubbed, onClose };
  }
  const zoomButton = (container: HTMLElement) => container.querySelector('.fb-lightbox-zoom') as HTMLButtonElement | null;

  it('offers 100% when the picture is shown smaller than its pixels, and "fit" once zoomed', () => {
    const { container, image } = renderLoaded();
    const button = zoomButton(container)!;
    expect(button.textContent).toBe('image_zoom_actual');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    // one picture pixel per screen pixel: 1970 / 300 fitted px, beyond the 4x of an ordinary zoom
    expect(readScale(image)).toBeCloseTo(1970 / 300, 2);
    expect(readScale(image)).toBeGreaterThan(4);
    expect(zoomButton(container)!.textContent).toBe('image_zoom_fit');
    expect(zoomButton(container)!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(zoomButton(container)!);
    expect(readScale(image)).toBe(1);
    expect(zoomButton(container)!.textContent).toBe('image_zoom_actual');
  });

  it('a double click toggles fit <-> 100% (anchored where it was clicked), a double tap does the same', () => {
    const { image } = renderLoaded();
    fireEvent.dblClick(image, { clientX: 100, clientY: 100 });
    expect(readScale(image)).toBeCloseTo(1970 / 300, 2);
    fireEvent.dblClick(image, { clientX: 100, clientY: 100 });
    expect(readScale(image)).toBe(1);
    fireEvent.touchStart(image, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchStart(image, { touches: [{ clientX: 203, clientY: 203 }] });
    fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 203, clientY: 203 }] });
    expect(readScale(image)).toBeCloseTo(1970 / 300, 2);
    fireEvent.touchStart(image, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchStart(image, { touches: [{ clientX: 203, clientY: 203 }] });
    fireEvent.touchEnd(image, { touches: [], changedTouches: [{ clientX: 203, clientY: 203 }] });
    expect(readScale(image)).toBe(1);
  });

  it('the wheel and a pinch may zoom up to 100% of a picture shown far smaller than its pixels (not only the shared 4x), never beyond the cap', () => {
    const { image } = renderLoaded();
    fireEvent.wheel(image, { deltaY: -5000, clientX: 200, clientY: 200 });
    expect(readScale(image)).toBeGreaterThan(4);
    expect(readScale(image)).toBeLessThanOrEqual(16);
    const huge = renderLoaded(vi.fn(), { width: 20000, height: 3000 });
    fireEvent.wheel(huge.image, { deltaY: -50000, clientX: 200, clientY: 200 });
    expect(readScale(huge.image)).toBeLessThanOrEqual(16);
  });

  it('a picture shown at (or above) its own size has no 100% button, and a double click still zooms in 2x', () => {
    const view = renderLoaded(vi.fn(), { width: 280, height: 280 });
    expect(zoomButton(view.container)).toBeNull();
    fireEvent.dblClick(view.image, { clientX: 150, clientY: 150 });
    expect(readScale(view.image)).toBe(2);
    expect(zoomButton(view.container)!.textContent).toBe('image_zoom_fit');
  });

  it('before the picture has loaded there is nothing to offer: no button, and the ordinary zoom range', () => {
    const { container } = render(<ImageLightbox src="data:image/png;base64,aW1n" onClose={vi.fn()} />);
    const { image } = stubLightboxGeometry(container);
    expect(zoomButton(container)).toBeNull();
    fireEvent.wheel(image, { deltaY: -50000, clientX: 200, clientY: 200 });
    expect(readScale(image)).toBeLessThanOrEqual(4);
  });

  it('a mouse drag pans the zoomed picture, ends without closing the lightbox, and does nothing when not zoomed', () => {
    const { container, image, onClose } = renderLoaded();
    // not zoomed: a drag does not pan
    fireEvent.mouseDown(image, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 260, clientY: 230 });
    fireEvent.mouseUp(window);
    expect(readTranslate(image)).toEqual({ x: 0, y: 0 });
    fireEvent.click(zoomButton(container)!);
    expect(image.classList.contains('is-zoomed')).toBe(true);
    const before = readTranslate(image);
    // The button starts at the picture's top-left corner (where a screenshot's text starts): the content is pushed right/down to the bound.
    expect(before.x).toBeCloseTo((1970 - 400) / 2, 0);
    expect(before.y).toBeCloseTo((1970 - 400) / 2, 0);
    fireEvent.mouseDown(image, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 140, clientY: 170 });
    fireEvent.mouseUp(window);
    expect(readTranslate(image).x).toBeCloseTo(before.x - 60, 0);
    expect(readTranslate(image).y).toBeCloseTo(before.y - 30, 0);
    // the click that ends the drag lands on the backdrop: it must not close the lightbox
    fireEvent.click(container.querySelector('.fb-lightbox')!);
    expect(onClose).not.toHaveBeenCalled();
    // the next plain click on the backdrop does close it
    return new Promise<void>((resolve) => setTimeout(() => {
      fireEvent.click(container.querySelector('.fb-lightbox')!);
      expect(onClose).toHaveBeenCalledTimes(1);
      resolve();
    }, 5));
  });

  it('a picture that loads from another source starts fit again, and a new source forgets the old size', () => {
    const onClose = vi.fn();
    const view = renderLoaded(onClose);
    fireEvent.click(zoomButton(view.container)!);
    expect(readScale(view.image)).toBeGreaterThan(4);
    view.rerender(<ImageLightbox src="data:image/png;base64,YW5vdGhlcg==" onClose={onClose} />);
    const next = view.container.querySelector('.fb-lightbox img') as HTMLImageElement;
    expect(readScale(next)).toBe(1);
    expect(zoomButton(view.container)).toBeNull();
  });

  it('closes with the visible, labelled close button and with Escape; the picture decodes off the main thread', () => {
    const { container, onClose, image } = renderLoaded();
    const close = container.querySelector('.fb-lightbox-close') as HTMLButtonElement;
    expect(close.getAttribute('aria-label')).toBe('close');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(image.getAttribute('decoding')).toBe('async');
  });
});
