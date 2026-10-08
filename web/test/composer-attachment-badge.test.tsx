/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const buildAttachmentDownloadUrl = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({ buildAttachmentDownloadUrl }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));
vi.mock('../src/components/ImageLightbox.js', () => ({
  ImageLightbox: ({ src, onClose, onImageError }: { src: string; onClose(): void; onImageError?: () => void }) => (
    <div data-testid="lightbox" data-src={src}>
      <button onClick={onClose}>close</button>
      <button onClick={() => onImageError?.()}>image-error</button>
    </div>
  ),
}));

import { ComposerAttachmentBadge } from '../src/components/ComposerAttachmentBadge.js';
import { forgetAttachmentPreview, rememberAttachmentPreview } from '../src/attachment-preview-cache.js';
import { ATTACHMENT_PREVIEW_LAYER_CLASS } from '../src/components/ComposerAttachmentBadge.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    expect(document.querySelector('.attachment-hover-preview')).toBeNull(); // not before the short delay
    act(() => { vi.advanceTimersByTime(200); });
    const preview = document.querySelector('.attachment-hover-preview img') as HTMLImageElement;
    expect(preview.getAttribute('src')).toBe('blob:local-1');
    expect(document.querySelector('.attachment-hover-preview-caption')!.textContent).toContain('#1 image.png');
    expect(buildAttachmentDownloadUrl).not.toHaveBeenCalled();

    firePointer(badge, 'leave', 'mouse');
    expect(document.querySelector('.attachment-hover-preview')).toBeNull();
  });

  it('falls back to the authenticated download URL for an attachment restored from a saved draft', async () => {
    const { container } = render(
      <ComposerAttachmentBadge {...base} attachmentId="att1" serverId="s1" sessionName="deck_x" />,
    );
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
    expect(buildAttachmentDownloadUrl).toHaveBeenCalledWith('s1', 'att1', 'deck_x');
    expect((document.querySelector('.attachment-hover-preview img') as HTMLImageElement).getAttribute('src'))
      .toBe('https://srv/api/server/s1/uploads/att1/download');
  });

  // The live server's CSP had no `blob:` in img-src, so a chip's local preview <img src="blob:..."> never loaded (the
  // browser blocks it and fires `error`). The chip must then use the uploaded file's download URL instead of staying blank.
  it('hover: a local preview the page refuses to load falls back to the download URL', async () => {
    rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
    const { container } = render(<ComposerAttachmentBadge {...base} attachmentId="att1" serverId="s1" sessionName="deck_x" />);
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    act(() => { vi.advanceTimersByTime(200); });
    const blocked = document.querySelector('.attachment-hover-preview img') as HTMLImageElement;
    expect(blocked.getAttribute('src')).toBe('blob:local-1');
    expect(buildAttachmentDownloadUrl).not.toHaveBeenCalled();
    await act(async () => { fireEvent.error(blocked); await Promise.resolve(); await Promise.resolve(); });
    expect(buildAttachmentDownloadUrl).toHaveBeenCalledWith('s1', 'att1', 'deck_x');
    expect((document.querySelector('.attachment-hover-preview img') as HTMLImageElement).getAttribute('src'))
      .toBe('https://srv/api/server/s1/uploads/att1/download');
    // The refused object URL is released and not offered again.
    expect((URL as unknown as { revokeObjectURL: ReturnType<typeof vi.fn> }).revokeObjectURL).toHaveBeenCalledWith('blob:local-1');
  });

  it('tap: the full preview falls back the same way, and once the download URL fails too it says so', async () => {
    rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
    const { container, getByRole, getByTestId } = render(<ComposerAttachmentBadge {...base} attachmentId="att1" serverId="s1" />);
    fireEvent.click(getByRole('button', { name: /upload\.preview_attachment/ }));
    expect(getByTestId('lightbox').getAttribute('data-src')).toBe('blob:local-1');
    await act(async () => { fireEvent.click(getByRole('button', { name: 'image-error' })); await Promise.resolve(); await Promise.resolve(); });
    expect(getByTestId('lightbox').getAttribute('data-src')).toBe('https://srv/api/server/s1/uploads/att1/download');
    // The download URL is refused too: no loop, an honest message.
    await act(async () => { fireEvent.click(getByRole('button', { name: 'image-error' })); await Promise.resolve(); });
    expect(buildAttachmentDownloadUrl).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="lightbox"]')).toBeNull();
    expect(document.querySelector('.attachment-lightbox-pending')!.textContent).toBe('upload.preview_unavailable');
  });

  it('a local preview that fails with no uploaded file to fall back to says so', async () => {
    rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
    const { container } = render(<ComposerAttachmentBadge {...base} />);
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    act(() => { vi.advanceTimersByTime(200); });
    await act(async () => { fireEvent.error(document.querySelector('.attachment-hover-preview img')!); await Promise.resolve(); });
    expect(document.querySelector('.attachment-hover-preview img')).toBeNull();
    expect(document.querySelector('.attachment-hover-preview-state')!.textContent).toBe('upload.preview_unavailable');
  });

  it('several attachments each fall back to their own download URL', async () => {
    buildAttachmentDownloadUrl.mockImplementation(async (_server: string, id: string) => `https://srv/dl/${id}`);
    const paths = ['/tmp/up/a/one.png', '/tmp/up/b/two.jpg'];
    let counter = 0;
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => `blob:local-${++counter}`);
    for (const path of paths) rememberAttachmentPreview(path, new File(['x'], path.split('/').pop()!, { type: 'image/png' }));
    const { container } = render(
      <>
        <ComposerAttachmentBadge {...base} seq={1} name="one.png" path={paths[0]!} attachmentId="aaa" serverId="s1" />
        <ComposerAttachmentBadge {...base} seq={2} name="two.jpg" path={paths[1]!} attachmentId="bbb" serverId="s1" />
      </>,
    );
    const badges = [...container.querySelectorAll('.attachment-badge')];
    for (const [index, badge] of badges.entries()) {
      enter(badge, 'mouse');
      act(() => { vi.advanceTimersByTime(200); });
      const img = document.querySelector('.attachment-hover-preview img') as HTMLImageElement;
      expect(img.getAttribute('src')).toBe(`blob:local-${index + 1}`);
      await act(async () => { fireEvent.error(img); await Promise.resolve(); await Promise.resolve(); });
      expect((document.querySelector('.attachment-hover-preview img') as HTMLImageElement).getAttribute('src')).toBe(`https://srv/dl/${index === 0 ? 'aaa' : 'bbb'}`);
      firePointer(badge, 'leave', 'mouse');
    }
    for (const path of paths) forgetAttachmentPreview(path);
  });

  it('keeps the serverId in the restored preview URL instead of using a host-global route', async () => {
    buildAttachmentDownloadUrl.mockResolvedValue('https://srv/api/server/server-211/uploads/att1/download?sessionName=deck_x');
    const { container } = render(
      <ComposerAttachmentBadge {...base} attachmentId="att1" serverId="server-211" sessionName="deck_x" />,
    );
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); });
    const source = (document.querySelector('.attachment-hover-preview img') as HTMLImageElement).getAttribute('src');
    expect(source).toContain('/api/server/server-211/uploads/att1/download');
    expect(buildAttachmentDownloadUrl).toHaveBeenCalledWith('server-211', 'att1', 'deck_x');
  });

  it('does not open a hover popover for touch, but a tap opens the full preview', async () => {
    rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
    const { container, getByRole, getByTestId } = render(<ComposerAttachmentBadge {...base} />);
    enter(container.querySelector('.attachment-badge')!, 'touch');
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('.attachment-hover-preview')).toBeNull();

    fireEvent.click(getByRole('button', { name: /upload\.preview_attachment/ }));
    expect(getByTestId('lightbox').getAttribute('data-src')).toBe('blob:local-1');
    fireEvent.click(getByRole('button', { name: 'close' }));
    expect(document.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  it('says so when a preview cannot be produced', async () => {
    buildAttachmentDownloadUrl.mockRejectedValue(new Error('nope'));
    const { container } = render(<ComposerAttachmentBadge {...base} attachmentId="att1" serverId="s1" />);
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('.attachment-hover-preview-state')!.textContent).toBe('upload.preview_unavailable');
  });

  it('leaves non-image attachments as plain chips', () => {
    const { container } = render(
      <ComposerAttachmentBadge {...base} name="report.pdf" path="/tmp/up/report.pdf" />,
    );
    expect(container.querySelector('.attachment-badge-main')).toBeNull();
    expect(container.querySelector('.attachment-badge')!.classList.contains('is-previewable')).toBe(false);
    enter(container.querySelector('.attachment-badge')!, 'mouse');
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('.attachment-hover-preview')).toBeNull();
  });

  it('keeps the original display name while normalizing the storage basename', () => {
    const { container } = render(
      <ComposerAttachmentBadge {...base} name="a<b>:c?.png" path="/tmp/up/a_b_c_.png" />,
    );
    expect(container.querySelector('.attachment-badge-name')?.textContent).toBe('a<b>:c?.png');
    expect(container.querySelector('.attachment-badge')?.classList.contains('is-previewable')).toBe(true);
  });

  it('removing does not open the preview', () => {
    const onRemove = vi.fn();
    const { container } = render(<ComposerAttachmentBadge {...base} onRemove={onRemove} />);
    fireEvent.click(container.querySelector('.attachment-badge-remove')!);
    expect(onRemove).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="lightbox"]')).toBeNull();
  });

  // "手机的预览图不要被其他组件挡住": the chip lives in `.attachment-badges` (position: relative; z-index: 1), so an overlay
  // rendered there ranks as z-index 1 against the app bars and the composer. Every overlay the chip opens goes to <body>.
  describe('layering', () => {
    const insideChip = (el: Element | null) => !!el?.closest('.attachment-badges, .attachment-badge');
    const composer = (children: preact.ComponentChild) => (
      <div class="controls"><div class="attachment-badges">{children}</div></div>
    );

    it('renders the hover popover, the lightbox and the loading cover as direct children of <body>, not inside the composer', async () => {
      rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
      const { container, getByRole } = render(composer(<ComposerAttachmentBadge {...base} />));
      enter(container.querySelector('.attachment-badge')!, 'mouse');
      act(() => { vi.advanceTimersByTime(200); });
      const hover = document.querySelector('.attachment-hover-preview')!;
      expect(hover.parentElement).toBe(document.body);
      expect(hover.classList.contains(ATTACHMENT_PREVIEW_LAYER_CLASS)).toBe(true);
      expect(insideChip(hover)).toBe(false);
      expect(container.querySelector('.attachment-hover-preview')).toBeNull();

      fireEvent.click(getByRole('button', { name: /upload\.preview_attachment/ }));
      const lightbox = document.querySelector('[data-testid="lightbox"]')!;
      expect(lightbox.parentElement).toBe(document.body);
      expect(insideChip(lightbox)).toBe(false);
      fireEvent.click(getByRole('button', { name: 'close' }));
      expect(document.querySelector('[data-testid="lightbox"]')).toBeNull();

      // The cover shown while the picture loads (or when it cannot) is layered the same way.
      buildAttachmentDownloadUrl.mockImplementation(() => new Promise(() => {}));
      const second = render(composer(<ComposerAttachmentBadge {...base} name="two.png" path="/tmp/up/two.png" attachmentId="b" serverId="s1" />));
      fireEvent.click(second.container.querySelector('.attachment-badge-main')!);
      const cover = document.querySelector('.attachment-lightbox-pending')!;
      expect(cover.parentElement).toBe(document.body);
      expect(cover.classList.contains(ATTACHMENT_PREVIEW_LAYER_CLASS)).toBe(true);
    });

    it('gives the overlay class to the real lightbox overlay and removes every overlay with the chip', () => {
      rememberAttachmentPreview(base.path, new File(['x'], 'image.png', { type: 'image/png' }));
      const view = render(composer(<ComposerAttachmentBadge {...base} />));
      fireEvent.click(view.getByRole('button', { name: /upload\.preview_attachment/ }));
      expect(document.body.querySelectorAll('[data-testid="lightbox"]')).toHaveLength(1);
      view.unmount();
      expect(document.body.querySelector('[data-testid="lightbox"]')).toBeNull();
      expect(document.body.querySelector('.attachment-hover-preview')).toBeNull();
    });

    it('the layer sits above every other app layer except the settings / OpenSpec dialogs, and follows the visual viewport', () => {
      const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
      const layer = Number(/--layer-attachment-preview:\s*(\d+)/.exec(css)![1]);
      const zIndexes = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
      const DIALOG_FLOOR = 2147483645;
      expect(Math.max(...zIndexes.filter((z) => z < DIALOG_FLOOR))).toBeLessThan(layer);
      expect(layer).toBeLessThan(DIALOG_FLOOR);
      const ruleOf = (selector: string) => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
      expect(ruleOf('.attachment-hover-preview {')).toContain('z-index: var(--layer-attachment-preview)');
      expect(ruleOf('.attachment-lightbox-pending {')).toContain('z-index: var(--layer-attachment-preview)');
      // The lightbox shares `.fb-lightbox` (z-index 9999 for the file browser); the chip's layer class overrides it.
      expect(ruleOf('.fb-lightbox.attachment-preview-layer')).toContain('z-index: var(--layer-attachment-preview)');
      // A phone's soft keyboard shrinks the visual viewport, not the layout one: the cover takes --vvh like the other full-screen layers.
      expect(css).toMatch(/\.fb-lightbox\.attachment-preview-layer[^{]*\{[^}]*height: var\(--vvh, 100dvh\)/);
    });
  });
});
