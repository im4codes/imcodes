/**
 * @vitest-environment jsdom
 */
import { fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/preact';
import { ImageLightbox } from '../../src/components/ImageLightbox.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').pop() ?? key }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ImageLightbox paging', () => {
  it('renders no arrows when the caller supplies no navigation', () => {
    const { container } = render(
      <ImageLightbox src="data:image/png;base64,AAA" onClose={() => {}} />,
    );
    expect(container.querySelectorAll('.fb-lightbox-nav')).toHaveLength(0);
  });

  it('pages with the arrow buttons', () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <ImageLightbox
        src="data:image/png;base64,AAA"
        onClose={() => {}}
        onNavigate={onNavigate}
        canPrev
        canNext
      />,
    );
    fireEvent.click(container.querySelector('.fb-lightbox-nav-prev')!);
    expect(onNavigate).toHaveBeenCalledWith(-1);
    fireEvent.click(container.querySelector('.fb-lightbox-nav-next')!);
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  // The element is tabIndex={-1} with no focus trap, so pressing a toolbar
  // button moves focus off it. Keys must still work afterwards, which is only
  // true if they are bound on the window.
  it('pages with arrow keys even after focus leaves the lightbox', () => {
    const onNavigate = vi.fn();
    render(
      <ImageLightbox
        src="data:image/png;base64,AAA"
        onClose={() => {}}
        onNavigate={onNavigate}
        canPrev
        canNext
      />,
    );
    document.body.focus();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNavigate).toHaveBeenCalledWith(1);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onNavigate).toHaveBeenCalledWith(-1);
  });

  it('does not page past the ends', () => {
    const onNavigate = vi.fn();
    render(
      <ImageLightbox
        src="data:image/png;base64,AAA"
        onClose={() => {}}
        onNavigate={onNavigate}
        canPrev={false}
        canNext={false}
      />,
    );
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('closes on Escape from the window', () => {
    const onClose = vi.fn();
    render(<ImageLightbox src="data:image/png;base64,AAA" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ImageLightbox drag-to-dismiss', () => {
  function drag(img: Element, dx: number, dy: number) {
    fireEvent.touchStart(img, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(img, { touches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
    fireEvent.touchEnd(img, { touches: [] });
  }

  it('closes on a committed vertical drag', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImageLightbox src="data:image/png;base64,AAA" onClose={onClose} />,
    );
    drag(container.querySelector('img')!, 0, 160);
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores a vertical drag that stops short of the threshold', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImageLightbox src="data:image/png;base64,AAA" onClose={onClose} />,
    );
    drag(container.querySelector('img')!, 0, 20);
    expect(onClose).not.toHaveBeenCalled();
  });

  // Horizontal swiping is the ingrained "next photo" gesture. If it dismissed,
  // every attempt to page would close the viewer instead.
  //
  // The vertical travel here deliberately exceeds the dismiss threshold: a flat
  // swipe would pass this test even with the axis check deleted, because it
  // never reaches the threshold in the first place. Only a slanted swipe
  // actually exercises axis dominance.
  it('does not close on a slanted horizontal swipe that clears the distance threshold', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImageLightbox src="data:image/png;base64,AAA" onClose={onClose} />,
    );
    drag(container.querySelector('img')!, 320, 130);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on a slanted drag that is dominantly vertical', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ImageLightbox src="data:image/png;base64,AAA" onClose={onClose} />,
    );
    drag(container.querySelector('img')!, 40, 180);
    expect(onClose).toHaveBeenCalled();
  });
});
