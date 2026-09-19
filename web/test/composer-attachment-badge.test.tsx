/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const buildAttachmentDownloadUrl = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({ buildAttachmentDownloadUrl }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));
vi.mock('../src/components/ImageLightbox.js', () => ({
  ImageLightbox: ({ src, onClose }: { src: string; onClose(): void }) => (
    <div data-testid="lightbox" data-src={src}><button onClick={onClose}>close</button></div>
  ),
}));

import { ComposerAttachmentBadge } from '../src/components/ComposerAttachmentBadge.js';
import { forgetAttachmentPreview, rememberAttachmentPreview } from '../src/attachment-preview-cache.js';

const base = { seq: 1, name: 'image.png', path: '/tmp/up/image.png', removing: false, onRemove: vi.fn() };

// Preact binds `onPointerEnter` to the lowercase event only when the DOM has an
// `onpointerenter` property; older jsdom builds do not, and it then listens for
// the literal `PointerEnter`. Real browsers always have it, so dispatch
// whichever name this environment is listening on.
function firePointer(el: Element, base: 'enter' | 'leave', pointerType: string) {
  const name = `pointer${base}`;
  const eventName = `on${name}` in el ? name : `Pointer${base === 'enter' ? 'Enter' : 'Leave'}`;
  const event = new Event(eventName, { bubbles: false }) as Event & { pointerType?: string };
  event.pointerType = pointerType;
  act(() => { el.dispatchEvent(event); });
}
const enter = (el: Element, pointerType: string) => firePointer(el, 'enter', pointerType);

describe('ComposerAttachmentBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    buildAttachmentDownloadUrl.mockReset();
    buildAttachmentDownloadUrl.mockResolvedValue('https://srv/api/server/s1/uploads/att1/download');
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:local-1');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    cleanup();
    forgetAttachmentPreview(base.path);
    vi.useRealTimers();
  });

  it('previews an image on mouse hover, from the local copy when the upload is still in memory', () => {
    rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
    const { container } = render(<ComposerAttachmentBadge {...base} />);
    const badge = container.querySelector('.attachment-badge')!;
    enter(badge, 'mouse');
    expect(container.querySelector('.attachment-hover-preview')).toBeNull(); // not before the short delay
    act(() => { vi.advanceTimersByTime(200); });
    const preview = container.querySelector('.attachment-hover-preview img') as HTMLImageElement;
    expect(preview.getAttribute('src')).toBe('blob:local-1');
    expect(container.querySelector('.attachment-hover-preview-caption')!.textContent).toContain('#1 image.png');
    expect(buildAttachmentDownloadUrl).not.toHaveBeenCalled();

    firePointer(badge, 'leave', 'mouse');
    expect(container.querySelector('.attachment-hover-preview')).toBeNull();
  });

  it('falls back to the authenticated download URL for an attachment restored from a saved draft', async () => {
    const { container } = render(
      <ComposerAttachmentBadge {...base} attachmentId="att1" serverId="s1" sessionName="deck_x" />,
    );
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
    expect(buildAttachmentDownloadUrl).toHaveBeenCalledWith('s1', 'att1', 'deck_x');
    expect((container.querySelector('.attachment-hover-preview img') as HTMLImageElement).getAttribute('src'))
      .toBe('https://srv/api/server/s1/uploads/att1/download');
  });

  it('does not open a hover popover for touch, but a tap opens the full preview', async () => {
    rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
    const { container, getByRole, getByTestId } = render(<ComposerAttachmentBadge {...base} />);
    enter(container.querySelector('.attachment-badge')!, 'touch');
    act(() => { vi.advanceTimersByTime(500); });
    expect(container.querySelector('.attachment-hover-preview')).toBeNull();

    fireEvent.click(getByRole('button', { name: /upload\.preview_attachment/ }));
    expect(getByTestId('lightbox').getAttribute('data-src')).toBe('blob:local-1');
    fireEvent.click(getByRole('button', { name: 'close' }));
    expect(container.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  it('says so when a preview cannot be produced', async () => {
    buildAttachmentDownloadUrl.mockRejectedValue(new Error('nope'));
    const { container } = render(<ComposerAttachmentBadge {...base} attachmentId="att1" serverId="s1" />);
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelector('.attachment-hover-preview-state')!.textContent).toBe('upload.preview_unavailable');
  });

  it('leaves non-image attachments as plain chips', () => {
    const { container } = render(
      <ComposerAttachmentBadge {...base} name="report.pdf" path="/tmp/up/report.pdf" />,
    );
    expect(container.querySelector('.attachment-badge-main')).toBeNull();
    expect(container.querySelector('.attachment-badge')!.classList.contains('is-previewable')).toBe(false);
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    act(() => { vi.advanceTimersByTime(500); });
    expect(container.querySelector('.attachment-hover-preview')).toBeNull();
  });

  it('removing does not open the preview', () => {
    const onRemove = vi.fn();
    const { container } = render(<ComposerAttachmentBadge {...base} onRemove={onRemove} />);
    fireEvent.click(container.querySelector('.attachment-badge-remove')!);
    expect(onRemove).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="lightbox"]')).toBeNull();
  });
});
