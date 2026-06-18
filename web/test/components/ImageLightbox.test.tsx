import { act, fireEvent, render, waitFor } from '@testing-library/preact';
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

describe('ImageLightbox', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as typeof globalThis & { ClipboardItem?: unknown }).ClipboardItem;
    delete (globalThis as typeof globalThis & { showSaveFilePicker?: unknown }).showSaveFilePicker;
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
    });
    expect(saveButton.textContent).toBe('image_downloaded');
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
});
