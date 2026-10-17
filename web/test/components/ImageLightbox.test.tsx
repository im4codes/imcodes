import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageLightbox } from '../../src/components/ImageLightbox.js';

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
    delete (globalThis as typeof globalThis & { ClipboardItem?: unknown }).ClipboardItem;
    delete (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker;
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

  it('keeps the native desktop image context menu', () => {
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
    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,aW1n"
        alt="result.png"
        onClose={vi.fn()}
      />,
    );

    const image = container.querySelector('.fb-lightbox img') as HTMLImageElement;
    fireEvent.contextMenu(image);

    expect(container.querySelector('.fb-lightbox-actions')).toBeNull();
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
