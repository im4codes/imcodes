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
});
