/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, afterEach } from 'vitest';
import { configure } from '../src/api.js';
import {
  buildQrMatrixPath,
  CLIENT_DOWNLOAD_PATHS,
  IOS_APP_STORE_URL,
  normalizeHttpOrigin,
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
});
