/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
// i18n stub: t must be reference-stable so effects do not re-run every render.
const stableT = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT, i18n: { language: 'en', changeLanguage: () => Promise.resolve() } }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const { ChatLocalImagePreview } = await import('../../src/components/ChatLocalImagePreview.js');

// tsk_5rf R2 / Cx P1-1. Streamed previews resolve a URL, not bytes. Treating a
// resolved URL as success meant a dead or expired handle rendered a broken
// image forever while the component claimed 'ok'. The visible state must stay
// loading until the real <img> load event, and an error must fail explicitly.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const STREAM_URL = 'https://host/api/server/s1/uploads/dl-1/download';

describe('ChatLocalImagePreview streamed load lifecycle (tsk_5rf R2)', () => {
  it('stays loading until the real image load event fires', async () => {
    const loader = vi.fn(async () => ({ dataUrl: STREAM_URL, alt: 'pic.png' }));
    const { container } = render(<ChatLocalImagePreview path="/repo/pic.png" loadImagePreview={loader} />);

    // The URL resolves, but no bytes have loaded yet: still loading.
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('.chat-local-image-preview-loading')).not.toBeNull();

    const img = container.querySelector('img') as HTMLImageElement;
    fireEvent.load(img);

    await waitFor(() => expect(container.querySelector('.chat-local-image-preview-loading')).toBeNull());
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('fails explicitly and drops the image when the streamed URL errors', async () => {
    const loader = vi.fn(async () => ({ dataUrl: STREAM_URL, alt: 'pic.png' }));
    const { container } = render(<ChatLocalImagePreview path="/repo/pic.png" loadImagePreview={loader} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    // A dead handle must not leave a broken image on screen.
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
    expect(container.querySelector('.chat-local-image-preview-loading')).toBeNull();
    // ...and the failure must be VISIBLE. Rendering null made a broken preview
    // indistinguishable from a message that never had an image at all.
    expect(container.querySelector('.chat-local-image-preview-error')).not.toBeNull();
    expect(container.textContent ?? '').not.toBe('');
  });

  it('reports the failure so the cached URL is evicted and the retry re-mints (tsk_5rf R2)', async () => {
    // Without this the component would fail visually while the loader cache
    // kept replaying the same dead URL on every retry.
    const onLoadFailed = vi.fn();
    const loader = vi.fn(async () => ({ dataUrl: STREAM_URL, alt: 'pic.png', onLoadFailed }));
    const { container } = render(<ChatLocalImagePreview path="/repo/pic.png" loadImagePreview={loader} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    await waitFor(() => expect(onLoadFailed).toHaveBeenCalledTimes(1));
  });

  it('does not report a failure on a successful load (tsk_5rf R2)', async () => {
    const onLoadFailed = vi.fn();
    const loader = vi.fn(async () => ({ dataUrl: STREAM_URL, alt: 'pic.png', onLoadFailed }));
    const { container } = render(<ChatLocalImagePreview path="/repo/pic.png" loadImagePreview={loader} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    fireEvent.load(container.querySelector('img') as HTMLImageElement);
    await waitFor(() => expect(container.querySelector('.chat-local-image-preview-loading')).toBeNull());
    expect(onLoadFailed).not.toHaveBeenCalled();
  });
});
