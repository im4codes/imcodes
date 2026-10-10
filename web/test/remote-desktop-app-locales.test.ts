import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import { INSTALL_GUIDANCE } from '../src/pwa-install.js';

const locales = { en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW } as Record<string, { remote_desktop: Record<string, string> }>;

/** One instruction per browser kind the detector can name, plus the fixed labels and the blocked-window notice. */
const GUIDE_KEYS = Object.values(INSTALL_GUIDANCE).map((kind) => `install_guide_${kind}`);
const LABEL_KEYS = ['install_app', 'install_app_hint', 'install_guide_close', 'window_blocked', 'window_blocked_dismiss'];
const REQUIRED = [...GUIDE_KEYS, ...LABEL_KEYS];

describe('install-as-app and blocked-window texts', () => {
  it.each(Object.keys(locales))('%s has every key, as non-empty text', (locale) => {
    for (const key of REQUIRED) {
      const value = locales[locale]!.remote_desktop[key];
      expect(typeof value, `${locale}.remote_desktop.${key}`).toBe('string');
      expect(value!.trim().length, `${locale}.remote_desktop.${key}`).toBeGreaterThan(0);
    }
  });

  it('is translated, not the English text copied into the other six languages', () => {
    for (const locale of Object.keys(locales).filter((name) => name !== 'en')) {
      for (const key of REQUIRED) {
        expect(locales[locale]!.remote_desktop[key], `${locale}.${key}`).not.toBe(locales.en!.remote_desktop[key]);
      }
    }
  });

  it('keeps each instruction about the right browser', () => {
    // the Firefox text explains why the address bar cannot go; it must not tell the user to install from a Firefox menu
    expect(en.remote_desktop.install_guide_firefox).toMatch(/Chrome or Edge/);
    expect(en.remote_desktop.install_guide_safari_mac).toMatch(/Add to Dock/);
    expect(en.remote_desktop.install_guide_safari_ios).toMatch(/Add to Home Screen/);
    expect(en.remote_desktop.install_guide_edge).toMatch(/Edge/);
    expect(en.remote_desktop.install_guide_chrome).toMatch(/Chrome/);
  });

  it('is used by the components under exactly these names (no key the UI asks for is missing)', () => {
    const used = new Set<string>();
    for (const file of ['components/RemoteDesktopInstallEntry.tsx', 'components/RemoteDesktopWindowBlockedNotice.tsx']) {
      const source = readFileSync(resolve(__dirname, '../src', file), 'utf8');
      for (const match of source.matchAll(/t\('remote_desktop\.([a-z_]+)'\)/g)) used.add(match[1]!);
    }
    for (const key of used) expect(REQUIRED, key).toContain(key);
    // the per-browser instruction is built from the detector's kinds
    const entry = readFileSync(resolve(__dirname, '../src/components/RemoteDesktopInstallEntry.tsx'), 'utf8');
    expect(entry).toContain('remote_desktop.install_guide_${install.guidance}');
  });
});
