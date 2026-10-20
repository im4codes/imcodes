import { describe, expect, it } from 'vitest';
import {
  LOCAL_PANEL_STRINGS,
  LOCAL_PANEL_STRING_KEYS,
  UI_LOCALE_AUTONYMS,
  localPanelText,
} from '../../shared/local-panel-strings.js';
import { UI_LOCALES } from '../../shared/ui-locale.js';

describe('local panel strings', () => {
  it('every locale has every key, and nothing else', () => {
    for (const locale of UI_LOCALES) {
      const table = LOCAL_PANEL_STRINGS[locale];
      expect(Object.keys(table).sort(), locale).toEqual([...LOCAL_PANEL_STRING_KEYS].sort());
      for (const key of LOCAL_PANEL_STRING_KEYS) expect(table[key].trim().length, `${locale}.${key}`).toBeGreaterThan(0);
    }
  });

  it('placeholders match the English string in every locale, so none is lost in translation', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1]).sort();
    for (const locale of UI_LOCALES) {
      for (const key of LOCAL_PANEL_STRING_KEYS) {
        expect(placeholders(LOCAL_PANEL_STRINGS[locale][key]), `${locale}.${key}`).toEqual(placeholders(LOCAL_PANEL_STRINGS.en[key]));
      }
    }
  });

  it('only the languages that are not English actually differ from English for the visible labels', () => {
    for (const locale of UI_LOCALES.filter((value) => value !== 'en')) {
      for (const key of ['navHome', 'allow', 'stopAll', 'emptyTitle', 'pausedTitle'] as const) {
        expect(LOCAL_PANEL_STRINGS[locale][key], `${locale}.${key}`).not.toBe(LOCAL_PANEL_STRINGS.en[key]);
      }
    }
  });

  it('keeps labels short enough for the fixed-width parts of the layout (rail label, buttons, pills)', () => {
    // Characters, not pixels: a CJK character is about twice a Latin one, so each is counted double.
    const width = (text: string) => [...text].reduce((sum, ch) => sum + (/[⺀-鿿가-힯＀-￯]/u.test(ch) ? 2 : 1), 0);
    const limits: Array<[Parameters<typeof localPanelText>[1], number]> = [
      ['navHome', 16], ['navSettings', 14], ['navAbout', 14],
      ['statusOnline', 14], ['statusBusy', 16], ['statusPaused', 16], ['statusOffline', 16],
      ['share', 14], ['resume', 16], ['stopAll', 22], ['disconnect', 16], ['copy', 14], ['control', 18], ['view', 14],
    ];
    for (const locale of UI_LOCALES) {
      for (const [key, limit] of limits) expect(width(LOCAL_PANEL_STRINGS[locale][key]), `${locale}.${key}`).toBeLessThanOrEqual(limit);
    }
  });

  it('fills placeholders, leaves unknown ones alone, and falls back to English for a missing locale', () => {
    expect(localPanelText('en', 'connectionsActive', { n: 3 })).toBe('3 active connection(s)');
    expect(localPanelText('ru', 'connectionsActive', { n: 2 })).toBe('Активных подключений: 2');
    expect(localPanelText('en', 'connectionsActive')).toBe('{{n}} active connection(s)');
    expect(localPanelText('en', 'connectionsActive', { x: 1 })).toBe('{{n}} active connection(s)');
    expect(localPanelText('xx' as never, 'share')).toBe('Share');
  });

  it('names every language in itself for the picker', () => {
    expect(Object.keys(UI_LOCALE_AUTONYMS).sort()).toEqual([...UI_LOCALES].sort());
    expect(UI_LOCALE_AUTONYMS['zh-TW']).toBe('繁體中文');
  });

  it('never embeds markup, which the panel renders as text', () => {
    for (const locale of UI_LOCALES) for (const key of LOCAL_PANEL_STRING_KEYS) expect(LOCAL_PANEL_STRINGS[locale][key], `${locale}.${key}`).not.toMatch(/[<>]/u);
  });
});
