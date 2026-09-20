import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

const LOCALES = { en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW } as const;

describe('independent session settings locale coverage', () => {
  it('ships supervision and model settings labels in every locale', () => {
    for (const [locale, messages] of Object.entries(LOCALES)) {
      const session = (messages as any).session;
      expect(session?.supervision?.settingsTitle, locale).toBeTruthy();
      for (const key of ['label', 'help', 'current', 'default', 'apply', 'applying', 'applied', 'failed', 'loading', 'unsupported']) {
        expect(session?.modelSettings?.[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
