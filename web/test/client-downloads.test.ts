/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { configure } from '../src/api.js';
import {
  buildQrMatrixPath,
  CLIENT_DOWNLOAD_PATHS,
  IOS_APP_STORE_URL,
  isDownloadApiUrl,
  isPcAppClient,
  isSafeHttpDownloadUrl,
  normalizeHttpOrigin,
  openPcAppDownloadUrl,
  resolveClientDownloadUrls,
  resolveDownloadOrigin,
} from '../src/client-downloads.js';
import { DEFAULT_SERVER_URL } from '../src/native.js';
import en from '../src/i18n/locales/en.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import es from '../src/i18n/locales/es.json';
import ru from '../src/i18n/locales/ru.json';

const originalLocation = window.location;

function setWindowOrigin(origin: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin },
  });
}

afterEach(() => {
  configure('');
  delete (globalThis as Record<string, unknown>).__IMCODES_PC_APP__;
  delete (globalThis as Record<string, unknown>).Capacitor;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  });
});

describe('client-downloads helpers', () => {
  it('normalizes only HTTP/HTTPS origins', () => {
    expect(normalizeHttpOrigin('https://app.im.codes/')).toBe('https://app.im.codes');
    expect(normalizeHttpOrigin('http://localhost:3000/foo/bar')).toBe('http://localhost:3000');
    expect(normalizeHttpOrigin('capacitor://localhost')).toBeNull();
    expect(normalizeHttpOrigin('file://')).toBeNull();
    expect(normalizeHttpOrigin('   ')).toBeNull();
  });

  it('resolves same-origin web, explicit configured base URL, and non-HTTP fallback', () => {
    setWindowOrigin('https://web.example.com');
    expect(resolveDownloadOrigin()).toBe('https://web.example.com');

    configure('https://custom.im.codes:9443/');
    expect(resolveDownloadOrigin()).toBe('https://custom.im.codes:9443');

    configure('');
    setWindowOrigin('capacitor://localhost');
    expect(resolveDownloadOrigin()).toBe(DEFAULT_SERVER_URL);

    setWindowOrigin('file://');
    expect(resolveDownloadOrigin()).toBe(DEFAULT_SERVER_URL);
  });

  it('builds complete client download URLs and local QR matrices without remote requests', () => {
    const urls = resolveClientDownloadUrls('https://host.im.codes');
    expect(urls.macArm64).toBe(`https://host.im.codes${CLIENT_DOWNLOAD_PATHS.macArm64}`);
    expect(urls.macIntel).toBe(`https://host.im.codes${CLIENT_DOWNLOAD_PATHS.macIntel}`);
    expect(urls.windows).toBe(`https://host.im.codes${CLIENT_DOWNLOAD_PATHS.windows}`);
    expect(urls.linuxDeb).toBe(`https://host.im.codes${CLIENT_DOWNLOAD_PATHS.linuxDeb}`);
    expect(urls.linuxSh).toBe(`https://host.im.codes${CLIENT_DOWNLOAD_PATHS.linuxSh}`);
    expect(urls.androidFcm).toBe(`https://host.im.codes${CLIENT_DOWNLOAD_PATHS.androidFcm}`);
    expect(urls.androidNoFcm).toBe(`https://host.im.codes${CLIENT_DOWNLOAD_PATHS.androidNoFcm}`);
    expect(urls.iosAppStore).toBe(IOS_APP_STORE_URL);

    const qrFcm = buildQrMatrixPath(urls.androidFcm);
    const qrNoFcm = buildQrMatrixPath(urls.androidNoFcm);
    const qrIos = buildQrMatrixPath(urls.iosAppStore);
    expect(qrFcm.size).toBeGreaterThan(20);
    expect(qrFcm.path.startsWith('M')).toBe(true);
    expect(qrNoFcm.path).not.toBe(qrFcm.path);
    expect(qrIos.size).toBeGreaterThan(20);
    expect(qrIos.path.startsWith('M')).toBe(true);
  });

  it('provides matching client_downloads translations across all 7 locales', () => {
    const expectedKeys = Object.keys(en.client_downloads).sort();
    expect(expectedKeys.length).toBeGreaterThan(10);
    for (const [name, locale] of Object.entries({ en, zhCN, zhTW, ja, ko, es, ru })) {
      expect(Object.keys(locale.client_downloads).sort(), `${name} missing/extra client_downloads keys`).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        expect((locale.client_downloads as Record<string, string>)[key]?.trim().length, `${name}.${key} empty`).toBeGreaterThan(0);
      }
    }
  });

  it('detects PC App Electron clients without misclassifying Capacitor or standard web browsers', () => {
    expect(isPcAppClient()).toBe(false);

    (globalThis as Record<string, unknown>).__IMCODES_PC_APP__ = { isElectron: true };
    expect(isPcAppClient()).toBe(true);

    // Capacitor native runtime wins over __IMCODES_PC_APP__
    (globalThis as Record<string, unknown>).Capacitor = { isNativePlatform: () => true };
    expect(isPcAppClient()).toBe(false);
  });

  it('validates download API URLs and resolves PC App downloads for redirect, stream, unsafe URLs, and old-server fallbacks', async () => {
    setWindowOrigin('https://host.im.codes');
    configure('https://host.im.codes');

    expect(isDownloadApiUrl('https://host.im.codes/api/downloads/latest/desktop-mac')).toBe(true);
    expect(isDownloadApiUrl('https://evil.example/api/downloads/latest/desktop-mac')).toBe(false);
    expect(isDownloadApiUrl('https://github.com/im4codes/imcodes/releases')).toBe(false);
    expect(isSafeHttpDownloadUrl('https://dl.im.codes/file.pkg')).toBe(true);
    expect(isSafeHttpDownloadUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpDownloadUrl('file:///etc/passwd')).toBe(false);

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const clickedAnchors: Array<{ href: string; download: string }> = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchors.push({ href: this.href, download: this.download });
    });

    // 1. mode: 'redirect' opens valid https URL via window.open
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      mode: 'redirect',
      url: 'https://dl.im.codes/releases/master/imcodes-desktop.pkg',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await openPcAppDownloadUrl('https://host.im.codes/api/downloads/latest/desktop-mac');
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('https://dl.im.codes/releases/master/imcodes-desktop.pkg', '_blank', 'noopener,noreferrer');
    expect(clickedAnchors).toHaveLength(0);

    // 2. Rejects dangerous redirect URLs (javascript:, file:) without opening or falling back
    openSpy.mockClear();
    for (const badUrl of ['javascript:alert(1)', 'file:///etc/passwd']) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        mode: 'redirect',
        url: badUrl,
      }), { status: 200, headers: { 'content-type': 'application/json' } })));
      await openPcAppDownloadUrl('https://host.im.codes/api/downloads/latest/desktop-mac');
      expect(openSpy).not.toHaveBeenCalled();
      expect(clickedAnchors).toHaveLength(0);
    }

    // 3. mode: 'stream' triggers hidden same-page <a download> click and cleans up DOM
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      mode: 'stream',
      url: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await openPcAppDownloadUrl('https://host.im.codes/api/downloads/latest/desktop-win');
    expect(openSpy).not.toHaveBeenCalled();
    expect(clickedAnchors).toEqual([{ href: 'https://host.im.codes/api/downloads/latest/desktop-win', download: '' }]);
    expect(document.body.querySelectorAll('a[download]')).toHaveLength(0);

    // 4. Non-JSON response (e.g. old server streaming binary directly) cancels body and falls back to <a download>
    clickedAnchors.length = 0;
    const cancelSpy = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) },
      body: { cancel: cancelSpy },
    })));
    await openPcAppDownloadUrl('https://host.im.codes/api/downloads/latest/desktop-linux-deb');
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
    expect(clickedAnchors).toEqual([{ href: 'https://host.im.codes/api/downloads/latest/desktop-linux-deb', download: '' }]);

    // 5. Same-origin reverse-proxy/R2 artifact URL triggers in-page <a download> preserving query params and NEVER opens window.open
    setWindowOrigin('https://selfhost.example');
    configure('https://selfhost.example');
    openSpy.mockClear();
    clickedAnchors.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      mode: 'redirect',
      url: 'https://selfhost.example/artifacts/master/imcodes.apk?v=9cc448ae',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await openPcAppDownloadUrl('https://selfhost.example/api/downloads/latest/android-with-fcm');
    expect(openSpy).not.toHaveBeenCalled();
    expect(clickedAnchors).toEqual([
      { href: 'https://selfhost.example/artifacts/master/imcodes.apk?v=9cc448ae', download: '' },
    ]);

    // 6. Same-origin self-referential /api/downloads/ URL falls back to clean base download URL without ?resolve=json or window.open
    openSpy.mockClear();
    clickedAnchors.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      mode: 'redirect',
      url: 'https://selfhost.example/api/downloads/latest/android-with-fcm?resolve=json',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await openPcAppDownloadUrl('https://selfhost.example/api/downloads/latest/android-with-fcm');
    expect(openSpy).not.toHaveBeenCalled();
    expect(clickedAnchors).toEqual([
      { href: 'https://selfhost.example/api/downloads/latest/android-with-fcm', download: '' },
    ]);

    // 7. Fetch error / old server rejection falls back to <a download>
    clickedAnchors.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network_failure');
    }));
    await openPcAppDownloadUrl('https://selfhost.example/api/downloads/latest/desktop-linux-sh');
    expect(openSpy).not.toHaveBeenCalled();
    expect(clickedAnchors).toEqual([{ href: 'https://selfhost.example/api/downloads/latest/desktop-linux-sh', download: '' }]);
    clickSpy.mockRestore();
  });
});
