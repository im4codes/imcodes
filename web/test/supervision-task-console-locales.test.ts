import { describe, expect, it } from 'vitest';
import { SUPERVISION_TASK_LIFECYCLE_STATUSES } from '@shared/supervision-config.js';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

const LOCALES = { en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW } as const;

function leafKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object'
      ? leafKeys(child as object, path)
      : [path];
  }).sort();
}

describe('supervision task console locales', () => {
  it('keeps every locale aligned and labels every fixed lifecycle status', () => {
    const expectedKeys = leafKeys(en.supervision_task_console);
    for (const [locale, messages] of Object.entries(LOCALES)) {
      expect(leafKeys(messages.supervision_task_console), locale).toEqual(expectedKeys);
      expect(Object.keys(messages.supervision_task_console.status).sort(), locale)
        .toEqual([...SUPERVISION_TASK_LIFECYCLE_STATUSES].sort());
      expect(messages.supervision_task_console.title.trim().length, locale).toBeGreaterThan(0);
      for (const key of ['tab_active', 'tab_history', 'no_active', 'no_history'] as const) {
        expect(messages.supervision_task_console[key].trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('does not silently fall back to English for the primary console labels', () => {
    for (const [locale, messages] of Object.entries(LOCALES)) {
      if (locale === 'en') continue;
      expect(messages.supervision_task_console.title, locale).not.toBe(en.supervision_task_console.title);
      expect(messages.supervision_task_console.loading, locale).not.toBe(en.supervision_task_console.loading);
      expect(messages.supervision_task_console.tab_history, locale).not.toBe(en.supervision_task_console.tab_history);
      expect(messages.supervision_task_console.no_history, locale).not.toBe(en.supervision_task_console.no_history);
    }
  });
});
