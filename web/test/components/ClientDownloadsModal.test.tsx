/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);
  const translation = { t };
  return { useTranslation: () => translation };
});

import { ClientDownloadsModal } from '../../src/components/ClientDownloadsModal.js';
import { configure } from '../../src/api.js';
import {
  CLIENT_DOWNLOAD_PATHS,
  GITHUB_RELEASES_URL,
  IOS_APP_STORE_URL,
} from '../../src/client-downloads.js';

afterEach(() => {
  cleanup();
  configure('');
  delete (globalThis as Record<string, unknown>).__IMCODES_PC_APP__;
  delete (globalThis as Record<string, unknown>).Capacitor;
  vi.restoreAllMocks();
});

describe('ClientDownloadsModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<ClientDownloadsModal open={false} onClose={() => {}} />);
    expect(container.querySelector('[data-testid="client-downloads-modal"]')).toBeNull();
  });

  it('renders all 5 platforms with OS SVG logos, exact links, and local QR SVGs', () => {
    configure('https://selfhosted.example.com:8443');
    const { container, getByTestId } = render(<ClientDownloadsModal open onClose={() => {}} />);

    for (const platform of ['macos', 'windows', 'linux', 'android', 'ios']) {
      const card = container.querySelector(`[data-platform="${platform}"]`);
      expect(card).not.toBeNull();
      expect(card!.querySelector('.client-downloads-os-logo svg')).not.toBeNull();
    }

    expect(getByTestId('download-link-mac-arm64').getAttribute('href')).toBe(
      `https://selfhosted.example.com:8443${CLIENT_DOWNLOAD_PATHS.macArm64}`,
    );
    expect(getByTestId('download-link-mac-intel').getAttribute('href')).toBe(
      `https://selfhosted.example.com:8443${CLIENT_DOWNLOAD_PATHS.macIntel}`,
    );
    expect(getByTestId('download-link-win').getAttribute('href')).toBe(
      `https://selfhosted.example.com:8443${CLIENT_DOWNLOAD_PATHS.windows}`,
    );
    expect(getByTestId('download-link-linux-deb').getAttribute('href')).toBe(
      `https://selfhosted.example.com:8443${CLIENT_DOWNLOAD_PATHS.linuxDeb}`,
    );
    expect(getByTestId('download-link-linux-sh').getAttribute('href')).toBe(
      `https://selfhosted.example.com:8443${CLIENT_DOWNLOAD_PATHS.linuxSh}`,
    );
    expect(getByTestId('download-link-ios').getAttribute('href')).toBe(IOS_APP_STORE_URL);
    expect(getByTestId('download-link-github-releases').getAttribute('href')).toBe(GITHUB_RELEASES_URL);

    // Verify title and subtitle use the client_downloads namespace
    expect(container.querySelector('#client-downloads-title')?.textContent).toBe('client_downloads.title');
    expect(container.querySelector('.client-downloads-subtitle')?.textContent).toBe('client_downloads.subtitle');

    // Zero remote <img> QR calls; local SVG path generated for both Android & iOS
    expect(container.querySelectorAll('img')).toHaveLength(0);
    const androidQr = getByTestId('download-qr-android');
    const iosQr = getByTestId('download-qr-ios');
    expect(androidQr.getAttribute('data-qr-value')).toBe(
      `https://selfhosted.example.com:8443${CLIENT_DOWNLOAD_PATHS.androidFcm}`,
    );
    expect(androidQr.querySelector('svg path')?.getAttribute('d')).toBeTruthy();
    expect(iosQr.getAttribute('data-qr-value')).toBe(IOS_APP_STORE_URL);
    expect(iosQr.querySelector('svg path')?.getAttribute('d')).toBeTruthy();
  });

  it('updates Android QR SVG and APK link when toggling between FCM and No FCM', () => {
    configure('https://app.im.codes');
    const { getByTestId } = render(<ClientDownloadsModal open onClose={() => {}} />);

    const qrBefore = getByTestId('download-qr-android').querySelector('svg path')?.getAttribute('d');
    expect(getByTestId('download-link-android').getAttribute('href')).toBe(
      `https://app.im.codes${CLIENT_DOWNLOAD_PATHS.androidFcm}`,
    );

    fireEvent.click(getByTestId('android-variant-nofcm'));
    const qrAfter = getByTestId('download-qr-android').querySelector('svg path')?.getAttribute('d');
    expect(getByTestId('download-qr-android').getAttribute('data-qr-value')).toBe(
      `https://app.im.codes${CLIENT_DOWNLOAD_PATHS.androidNoFcm}`,
    );
    expect(getByTestId('download-link-android').getAttribute('href')).toBe(
      `https://app.im.codes${CLIENT_DOWNLOAD_PATHS.androidNoFcm}`,
    );
    expect(qrAfter).toBeTruthy();
    expect(qrAfter).not.toBe(qrBefore);

    fireEvent.click(getByTestId('android-variant-fcm'));
    expect(getByTestId('download-link-android').getAttribute('href')).toBe(
      `https://app.im.codes${CLIENT_DOWNLOAD_PATHS.androidFcm}`,
    );
  });

  it('dismisses cleanly on close button click, backdrop click, and Escape key', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<ClientDownloadsModal open onClose={onClose} />);

    fireEvent.click(getByTestId('client-downloads-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(getByTestId('client-downloads-modal'));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps Android and iOS QR frames uniform and aligned above bottom buttons via CSS contract', () => {
    configure('https://selfhosted.example.com:8443/custom/subpath');
    const { getByTestId } = render(<ClientDownloadsModal open onClose={() => {}} />);

    const androidSvg = getByTestId('download-qr-android').querySelector('svg');
    const iosSvg = getByTestId('download-qr-ios').querySelector('svg');
    expect(androidSvg?.getAttribute('width')).toBe('136');
    expect(androidSvg?.getAttribute('height')).toBe('136');
    expect(iosSvg?.getAttribute('width')).toBe('136');
    expect(iosSvg?.getAttribute('height')).toBe('136');

    fireEvent.click(getByTestId('android-variant-nofcm'));
    expect(androidSvg?.getAttribute('width')).toBe('136');
    expect(androidSvg?.getAttribute('height')).toBe('136');

    const css = readFileSync(resolve(__dirname, '../../src/styles.css'), 'utf8');
    expect(css).toMatch(/\.client-downloads-mobile-card\s+\.client-downloads-qr-frame\s*\{[^}]*margin-top:\s*auto/s);
    expect(css).toMatch(/\.client-downloads-mobile-card\s+\.client-downloads-btn-full\s*\{[^}]*margin-top:\s*0/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*\.client-downloads-mobile-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });

  it('intercepts same-origin /api/downloads/ clicks in Electron PC App via ?resolve=json while preserving external links and normal web browser clicks', async () => {
    configure('https://app.im.codes');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      mode: 'redirect',
      url: 'https://dl.im.codes/releases/master/imcodes-desktop-v1.0.0-arm64.pkg',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    // 1. Standard web browser (no __IMCODES_PC_APP__): leaves default <a> behavior untouched
    const { getByTestId, unmount } = render(<ClientDownloadsModal open onClose={() => {}} />);
    const webMacLink = getByTestId('download-link-mac-arm64');
    const webClickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    webMacLink.dispatchEvent(webClickEvent);
    expect(webClickEvent.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    unmount();

    // 2. Electron PC App: intercepts /api/downloads/ clicks, resolves external URL, and opens via window.open
    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = { isElectron: true };
    const pcRender = render(<ClientDownloadsModal open onClose={() => {}} />);
    const pcMacLink = pcRender.getByTestId('download-link-mac-arm64');
    const pcClickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    pcMacLink.dispatchEvent(pcClickEvent);
    expect(pcClickEvent.defaultPrevented).toBe(true);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://app.im.codes/api/downloads/latest/desktop-mac?resolve=json',
        expect.objectContaining({ credentials: 'same-origin' }),
      );
      expect(openSpy).toHaveBeenCalledWith(
        'https://dl.im.codes/releases/master/imcodes-desktop-v1.0.0-arm64.pkg',
        '_blank',
        'noopener,noreferrer',
      );
    });

    // External store/GitHub links are NOT intercepted in PC App (security.ts windowOpenHandler sends them to openExternal directly)
    fetchMock.mockClear();
    const githubLink = pcRender.getByTestId('download-link-github-releases');
    const githubEv = new MouseEvent('click', { bubbles: true, cancelable: true });
    githubLink.dispatchEvent(githubEv);
    expect(githubEv.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
