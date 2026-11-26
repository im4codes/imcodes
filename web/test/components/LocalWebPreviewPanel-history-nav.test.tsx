/**
 * @vitest-environment jsdom
 *
 * Local Web Preview back/forward buttons.
 *
 * These drive the PREVIEW IFRAME's own session history (`contentWindow.history`)
 * rather than an app-level stack of the addresses this panel opened, because the
 * user also navigates by clicking links *inside* the preview — an app-level
 * stack would silently skip those and behave unlike a browser.
 *
 * That only works while the proxy URL is same-origin, which it is: nothing ever
 * calls `configure()`, so `getApiBaseUrl()` falls back to
 * `window.location.origin`. If a future change wires the buttons to something
 * else (or drops the ref), these tests fail.
 */
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('../../src/native.js', () => ({ isNative: () => false }));

vi.mock('../../src/api.js', () => ({
  createLocalWebPreview: vi.fn(async () => ({
    previewId: 'preview-1',
    previewAccessToken: 'tok',
  })),
  closeLocalWebPreview: vi.fn(async () => {}),
  normalizeLocalWebPreviewPath: (p: string) => (p && p.startsWith('/') ? p : `/${p || ''}`),
  buildLocalWebPreviewProxyUrl: (_s: string, id: string, path: string) =>
    `${window.location.origin}/api/server/s1/local-web/${id}${path}`,
}));

const { LocalWebPreviewPanel } = await import('../../src/components/LocalWebPreviewPanel.js');

describe('LocalWebPreviewPanel back/forward navigation', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  async function renderWithPreview() {
    const utils = render(h(LocalWebPreviewPanel, { serverId: 's1', port: '3000', path: '/' }));
    // The panel auto-opens once it has a port; wait for the iframe to mount.
    const iframe = await waitFor(() => {
      const el = document.querySelector('iframe');
      if (!el) throw new Error('iframe not mounted');
      return el as HTMLIFrameElement;
    }, { timeout: 3000 });

    // jsdom gives the frame a real contentWindow but navigating it is a no-op,
    // so spy on `history.go` to observe exactly what the buttons request.
    const go = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get: () => ({ history: { go } }),
    });
    return { ...utils, iframe, go };
  }

  function iconButton(label: string): HTMLButtonElement {
    const el = document.querySelector(`button[aria-label="${label}"]`);
    if (!el) throw new Error(`no button labelled ${label}`);
    return el as HTMLButtonElement;
  }

  it('drives the preview iframe history back and forward', async () => {
    const { go } = await renderWithPreview();

    fireEvent.click(iconButton('localWebPreview.back'));
    expect(go).toHaveBeenCalledWith(-1);

    fireEvent.click(iconButton('localWebPreview.forward'));
    expect(go).toHaveBeenCalledWith(1);
    expect(go).toHaveBeenCalledTimes(2);
  });

  it('renders the controls as icons only, with no text label', async () => {
    await renderWithPreview();
    for (const label of ['localWebPreview.back', 'localWebPreview.forward']) {
      // Arrow glyph only — any word-character would mean a text label crept in.
      expect(iconButton(label).textContent?.trim()).toMatch(/^[←→]$/);
    }
  });

  it('survives a cross-origin frame instead of throwing out of the click handler', async () => {
    const { iframe } = await renderWithPreview();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get: () => { throw new DOMException('blocked a frame', 'SecurityError'); },
    });
    expect(() => fireEvent.click(iconButton('localWebPreview.back'))).not.toThrow();
  });
});
